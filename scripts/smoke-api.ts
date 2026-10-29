// One-time check of the API behaviors the design relies on, against the real endpoint (needs a
// key). Core checks run the production code paths and print PASS or FAIL each:
//   1. strict tool        the copilot request, with the real prefix and tool schemas, returns a
//                         calculate_payment call whose arguments are exact integers
//   2. prompt caching     a second call over the same prefix reads cached tokens
//   3. JSON output format the judge returns conforming structured output, and it blocks an
//                         approval claim while passing a neutral explanation
// `--probes` adds the design's behavior probes (item 73), printed as INFO: forced tool_choice,
// disabling thinking, assistant prefill, citations with a JSON format, and whether thinking
// tokens count toward max_tokens on Haiku. Usage: npm run smoke [-- --probes]

import type Anthropic from "@anthropic-ai/sdk";
import { audit, type Ctx } from "../server/audit-log.js";
import { config, useCases } from "../server/config.js";
import { renderStablePrefix } from "../server/copilot/context.js";
import { CalculatePaymentArgsSchema, CALCULATE_PAYMENT, TOOLS } from "../server/copilot/tools.js";
import { CATALOG } from "../server/domain/catalog.js";
import { runJudge } from "../server/guardrail/judge.js";
import { copilotCall, newSdkClient } from "../server/llm/client.js";
import { loadEnvFile } from "../server/load-env.js";

loadEnvFile();

const probes = process.argv.includes("--probes");
const ctx: Ctx = { application_id: "smoke", session_id: "smoke", actor: { type: "system", id: "smoke" } };

let failures = 0;
const report = (ok: boolean, name: string, detail: string): void => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};
const info = (name: string, detail: string): void => console.log(`INFO  ${name}: ${detail}`);

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max)}...` : text);
const describeError = (err: unknown): string => {
  const e = err as { status?: number; message?: string };
  return `rejected${e.status ? ` (HTTP ${e.status})` : ""}: ${clip(String(e.message ?? err).replace(/\s+/g, " "))}`;
};

async function coreChecks(): Promise<void> {
  const system = [
    { type: "text" as const, text: renderStablePrefix(CATALOG), cache_control: { type: "ephemeral" as const } },
    { type: "text" as const, text: "Application state: empty form." },
  ];
  const ask = (text: string) =>
    copilotCall(ctx, { system, messages: [{ role: "user", content: `[m_1] ${text}` }], tools: TOOLS, message_ids: ["m_1"] });

  // 1. strict tool, tool_choice auto, effort low, through the production request.
  const first = await ask("The project is $30K. What would the monthly payment look like?");
  const toolUses = first.message.content.flatMap((block) => (block.type === "tool_use" ? [block] : []));
  const calculation = toolUses.find((block) => block.name === CALCULATE_PAYMENT);
  const args = calculation ? CalculatePaymentArgsSchema.safeParse(calculation.input) : undefined;
  report(
    first.message.stop_reason === "tool_use" &&
      args?.success === true &&
      args.data.amount_cents === 3_000_000 &&
      args.data.product_ids.length === 3,
    "strict tool",
    `stop_reason=${first.message.stop_reason}, ${toolUses.map((b) => `${b.name}(${JSON.stringify(b.input)})`).join(" + ")}, ` +
      `${Math.round(first.latency_ms)} ms`,
  );

  // 2. prompt caching: a different message over the same prefix.
  const second = await ask("What would $45,000 over 15 years cost per month?");
  report(
    second.usage.cache_read > 0,
    "prompt caching",
    `call 1 input=${first.usage.input} cache_read=${first.usage.cache_read}; call 2 input=${second.usage.input} cache_read=${second.usage.cache_read} ` +
      `(${Math.round(second.latency_ms)} ms)`,
  );

  // 3. JSON output format, through the production judge.
  const bad = await runJudge(ctx, "Option A looks good, and she is pre-approved for this, so act now.");
  const good = await runJudge(
    ctx,
    "Option A is a fixed-rate loan with the same payment every month. Option B charges no interest for an introductory period, and after that interest applies to the balance still owed.",
  );
  report(
    bad.verdict.outcome !== "judge_unavailable" && good.verdict.outcome !== "judge_unavailable",
    "JSON output format",
    `both replies conformed to the schema (bad: ${bad.verdict.outcome}, good: ${good.verdict.outcome})`,
  );
  report(
    bad.verdict.outcome === "blocked",
    "judge blocks an approval claim",
    `${bad.verdict.outcome}: ${clip(bad.verdict.reason ?? "", 120)}`,
  );
  report(
    good.verdict.outcome === "pass",
    "judge passes a neutral explanation",
    `${good.verdict.outcome}: ${clip(good.verdict.reason ?? "", 120)}`,
  );

  const calls = audit.list("smoke").filter((event) => event.type === "model.call");
  report(calls.length === 4, "model.call events", `${calls.length} events validated against the audit schema`);
}

async function behaviorProbes(): Promise<void> {
  const client = newSdkClient();
  const { copilot, judge } = useCases();
  const tryCall = async (name: string, run: () => Promise<Anthropic.Message>): Promise<void> => {
    try {
      const message = await run();
      const types = message.content.map((block) => block.type).join("+");
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
      info(name, `accepted; stop_reason=${message.stop_reason}, output_tokens=${message.usage.output_tokens}, blocks=${types}, text=${JSON.stringify(clip(text, 60))}`);
    } catch (err) {
      info(name, describeError(err));
    }
  };
  const small = { max_tokens: 512, messages: [{ role: "user" as const, content: "What is a monthly payment on a $1,000 loan? Answer briefly." }] };

  await tryCall("forced tool_choice on Sonnet 5.5", () =>
    client.messages.create({
      model: copilot.model,
      ...small,
      tools: TOOLS,
      tool_choice: { type: "tool", name: CALCULATE_PAYMENT },
      output_config: { effort: "low" },
    }),
  );
  await tryCall("thinking disabled on Sonnet 5.5", () =>
    client.messages.create({
      model: copilot.model,
      ...small,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
    } as never),
  );
  await tryCall("assistant prefill on Sonnet 5.5", () =>
    client.messages.create({
      model: copilot.model,
      max_tokens: 256,
      messages: [
        { role: "user", content: "Say hello in one short sentence." },
        { role: "assistant", content: "Hello, and" },
      ],
      output_config: { effort: "low" },
    }),
  );
  await tryCall("citations together with output_config.format on Haiku 5.5", () =>
    client.messages.create({
      model: judge.model,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: "The loan term is ten years." },
              citations: { enabled: true },
            },
            { type: "text", text: "What is the loan term?" },
          ],
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
        },
      },
    }),
  );
  await tryCall("thinking tokens against max_tokens=64 on Haiku 5.5", () =>
    client.messages.create({
      model: judge.model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      output_config: { effort: "low" },
    }),
  );
}

async function main(): Promise<void> {
  if (!config.hasLlmKey) {
    console.log("SKIP  no ANTHROPIC_API_KEY is set (add it to .env); nothing was called.");
    return;
  }
  console.log(`Endpoint: ${config.llmBaseUrl ?? "https://api.anthropic.com"}`);
  console.log(`Models: copilot=${useCases().copilot.model} judge=${useCases().judge.model}`);
  await coreChecks();
  if (probes) await behaviorProbes();
  console.log(failures === 0 ? "\nAll core checks passed." : `\n${failures} core check(s) failed.`);
}

main()
  .catch((err) => {
    failures += 1;
    console.error("FAIL  smoke script error:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  })
  .finally(() => {
    // Exit explicitly: an open connection must not hold the process after the checks are done.
    process.exit(failures === 0 ? 0 : 1);
  });
