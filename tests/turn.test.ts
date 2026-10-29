import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HomeownerViewPropsSchema,
  OptionsLineSchema,
  StreamLineSchema,
  type AuditEvent,
  type StreamLine,
} from "@shared/schemas";
import { createApiRouter } from "../server/api/index.js";
import { audit, createAuditLog, createMemorySink, installAuditLog, type Ctx } from "../server/audit-log.js";
import { setFieldValue } from "../server/commands.js";
import { splitWindow, TURN_WINDOW } from "../server/copilot/context.js";
import { runTurn, splitQuestion } from "../server/copilot/turn.js";
import { AppError } from "../server/errors.js";
import {
  CANNED_SENTENCE,
  CHAT_FOOTER,
  FALLBACK_MARKER,
  FALLBACK_REPLY,
  STATUS_STEPS,
} from "../server/guardrail/fallback.js";
import { sdkBaseUrl, setClientForTests } from "../server/llm/client.js";
import { services } from "../server/services/index.js";
import { store } from "../server/store.js";

// The copilot turn against a scripted stand-in for the SDK client: the tool loop, the stream
// lines, the guardrail's regenerate-once-then-fallback, provenance and the audit chain. No key.

const APP = "app_demo_001";
const ctx: Ctx = { application_id: APP, session_id: "turn-test", actor: { type: "contractor", id: "ctr_demo_001" } };

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };
const message = (content: unknown[], stop_reason: string) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "test",
  content,
  stop_reason,
  stop_sequence: null,
  usage,
});
const text = (value: string) => ({ type: "text", text: value, citations: null });
const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
  caller: { type: "direct" },
});
const say = (value: string) => message([text(value)], "end_turn");
const judged = (verdict: "pass" | "block", category = "none", rationale = "No issues.") => {
  const out = { verdict, category, rationale };
  return { ...message([text(JSON.stringify(out))], "end_turn"), parsed_output: out };
};
const CALC_ALL = toolUse("t1", "calculate_payment", {
  amount_cents: 3_000_000,
  term_months: null,
  product_ids: ["fixed_10y", "zero_intro_18m", "deferred_12m"],
});

type Reply = unknown;

/** A client whose `create` and `parse` answer from queues, recording each request. */
function scripted(create: Reply[], parse: Reply[] = []) {
  const created: any[] = [];
  const parsed: any[] = [];
  const answer = (queue: Reply[], seen: any[], params: unknown) => {
    seen.push(params);
    const next = queue.shift();
    if (next === undefined) throw new Error("the script ran out of replies");
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  setClientForTests({
    messages: {
      create: (params: unknown) => answer(create, created, params),
      parse: (params: unknown) => answer(parse, parsed, params),
    },
  });
  return { created, parsed };
}

async function turn(input: string): Promise<StreamLine[]> {
  const lines: StreamLine[] = [];
  await runTurn(ctx, input, (line) => lines.push(line));
  return lines;
}

const events = (): AuditEvent[] => audit.list(APP);
const ofType = <T extends AuditEvent["type"]>(type: T) =>
  events().filter((event): event is Extract<AuditEvent, { type: T }> => event.type === type);
const types = (lines: StreamLine[]) => lines.map((line) => line.type);

beforeEach(() => {
  store.reset();
  store.loadSeed();
  installAuditLog(createAuditLog(createMemorySink()));
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("COPILOT_ENABLED", "true");
});

afterEach(() => {
  setClientForTests(undefined);
  vi.unstubAllEnvs();
});

describe("a payment turn", () => {
  it("streams status, options, proposals and the explanation, and links every event to its parent", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    const explanation =
      "Option A is a fixed-rate loan at 9.99% APR: $396.29 a month for 120 months. Option B charges no interest at first, and then interest applies to the balance still owed.";
    scripted(
      [
        message(
          [
            CALC_ALL,
            toolUse("t2", "propose_field_fill", {
              field: "project_amount",
              value: "$30K",
              message_id: "m_1",
              verbatim_quote: "The project is $30K",
            }),
          ],
          "tool_use",
        ),
        say(explanation),
      ],
      [judged("pass")],
    );

    const lines = await turn("The project is $30K. What would the monthly payment look like?");

    expect(types(lines)).toEqual([
      "status",
      "status",
      "options",
      "proposals",
      "status",
      "status",
      "explanation",
      "done",
    ]);
    expect(lines.flatMap((l) => (l.type === "status" ? [l.step] : []))).toEqual([
      STATUS_STEPS[0],
      STATUS_STEPS[1],
      STATUS_STEPS[2],
      STATUS_STEPS[3],
    ]);
    for (const line of lines) expect(StreamLineSchema.safeParse(line).success).toBe(true);

    const options = lines.find((l) => l.type === "options");
    if (options?.type !== "options") throw new Error("no options line");
    expect(OptionsLineSchema.safeParse(options).success).toBe(true);
    expect(options.inputs_echo).toBe("$30,000.00 over 120 months");
    expect(options.inputs_source).toEqual({ amount: "form", term: "catalog" });
    expect(options.argument_label).toBeNull();
    expect(options.footer).toBe(CHAT_FOOTER);
    expect(options.calculator_result.options).toHaveLength(3);
    expect(options.disclosure_block.options).toHaveLength(3);

    const proposals = lines.find((l) => l.type === "proposals");
    if (proposals?.type !== "proposals") throw new Error("no proposals line");
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({ field_key: "project_amount", value: 3_000_000, state: "proposed" });
    expect(proposals.proposals[0]?.source).toEqual({
      kind: "message",
      ref: { message_id: "m_1", quote: "The project is $30K" },
    });

    const shown = lines.find((l) => l.type === "explanation");
    if (shown?.type !== "explanation") throw new Error("no explanation line");
    expect(shown.text).toBe(explanation);
    expect(shown.footer).toBe(CHAT_FOOTER);

    const done = lines.at(-1);
    if (done?.type !== "done") throw new Error("no done line");
    expect(done.event_ids.length).toBe(events().filter((e) => e.turn_id !== undefined).length);

    // The explanation is stored on the Options record the turn created.
    expect(store.getOptions(options.options_id)?.explanation).toBe(explanation);

    // Audit: the calculator is a LIVE tool call naming its Options record; the catalog read is a mock.
    const calls = ofType("tool.call");
    const calculator = calls.find((c) => c.service === "calculator");
    expect(calculator?._mock).toBeUndefined();
    expect(calculator?.options_id).toBe(options.options_id);
    expect(calls.find((c) => c.service === "catalog")?._mock?.mock_version).toBe(1);

    // Two copilot calls plus the judge's; usage and the full request are recorded.
    const modelCalls = ofType("model.call");
    expect(modelCalls.map((c) => c.use_case)).toEqual(["copilot", "copilot", "judge"]);
    expect(modelCalls[0]?.usage).toEqual({ input: 100, output: 20, cache_read: 50 });
    expect(modelCalls[0]?.context.message_ids).toEqual(["m_1"]);
    expect(modelCalls[0]?.context.system_prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(modelCalls[0]?.raw_input)).toContain("calculate_payment");

    // All three checks ran and passed.
    expect(ofType("guardrail.verdict").map((v) => [v.layer, v.outcome])).toEqual([
      ["denylist", "pass"],
      ["number_match", "pass"],
      ["judge", "pass"],
    ]);

    // Every event of the turn but the contractor's message has a parent inside the turn.
    const inTurn = events().filter((e) => e.turn_id !== undefined);
    const ids = new Set(inTurn.map((e) => e.event_id));
    for (const event of inTurn) {
      if (event.type === "message.received" && event.actor.type === "contractor") {
        expect(event.parent_event_id).toBeUndefined();
      } else {
        expect(ids.has(event.parent_event_id ?? "")).toBe(true);
      }
    }
  });

  it("sends the options table's cells as strings on the options line, formatted by the server", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    const { created } = scripted([message([CALC_ALL], "tool_use"), say("Option A costs less per month.")], [judged("pass")]);
    const lines = await turn("What would the monthly payment look like?");
    const options = lines.find((l) => l.type === "options");
    if (options?.type !== "options") throw new Error("no options line");
    expect(options.options_display).toEqual([
      { label: "Option A", product_id: "fixed_10y", payment_text: "$396.29 a month", term_text: "120 months", apr_text: "9.99%" },
      {
        label: "Option B",
        product_id: "zero_intro_18m",
        payment_text: "$250.00 a month for the first 18 months, then $414.14 a month",
        term_text: "120 months",
        apr_text: "8.96%",
      },
      {
        label: "Option C",
        product_id: "deferred_12m",
        payment_text: "$2,500.00 a month for 12 months",
        term_text: "120 months",
        apr_text: "0.00%",
      },
    ]);
    expect(options.options_display.map((entry) => entry.label)).toEqual(
      options.calculator_result.options.map((option) => option.label),
    );
    // The model's own tool result is unchanged by it.
    expect(JSON.parse(created[1].messages.at(-1).content[0].content)).not.toHaveProperty("options_display");
  });

  it("sends the model no cents, replays tool results in call order, and caches the stable prefix", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    const { created } = scripted([message([CALC_ALL], "tool_use"), say("Option A costs less per month.")], [judged("pass")]);
    await turn("What would the monthly payment look like?");

    const second = created[1];
    const toolMessage = second.messages.at(-1);
    expect(toolMessage.role).toBe("user");
    expect(toolMessage.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    const result = JSON.parse(toolMessage.content[0].content);
    expect(result.amount_used).toBe("$30,000.00");
    expect(JSON.stringify(result)).not.toMatch(/_cents/);
    expect(result.options[0].payments).toBe("120 monthly payments of $396.29");

    // The assistant's tool_use turn is replayed verbatim before the results.
    expect(second.messages.at(-2)).toEqual({ role: "assistant", content: [CALC_ALL] });

    // Cache breakpoint on the stable block, the volatile block after it; tools strict, tool_choice auto.
    expect(second.system).toHaveLength(2);
    expect(second.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(second.system[1].cache_control).toBeUndefined();
    expect(created[0].system[0].text).toBe(second.system[0].text);
    expect(second.tool_choice).toEqual({ type: "auto" });
    expect(second.tools.every((tool: { strict: boolean }) => tool.strict)).toBe(true);
    expect(second.thinking).toBeUndefined();
    expect(second.output_config).toEqual({ effort: "low" });
    expect(second.messages[0].content).toContain("[m_1] ");
  });

  it("tells the model to write money as $1,234.56 and terms as digits", async () => {
    const { created } = scripted([say("Option A is a fixed-rate loan.")], [judged("pass")]);
    await turn("Explain Option A.");
    const prefix: string = created[0].system[0].text;
    expect(prefix).toContain('"$1,234.56"');
    expect(prefix).toContain('as digits, as in "120 months" or "10 years"');
    expect(prefix).toContain("Never spell a figure out in words");
  });

  it("uses the model's amount, and labels it, when the application has none", async () => {
    scripted([message([CALC_ALL], "tool_use"), say("Option A costs less per month.")], [judged("pass")]);
    const lines = await turn("The project is $30K. What would the monthly payment look like?");
    const options = lines.find((l) => l.type === "options");
    if (options?.type !== "options") throw new Error("no options line");
    expect(options.inputs_source).toEqual({ amount: "argument", term: "catalog" });
    expect(options.argument_label).toBe("based on an amount not yet on the application");
  });

  it("prices the application's amount, not the model's, and tells the model about the difference", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    const { created } = scripted(
      [
        message(
          [toolUse("t1", "calculate_payment", { amount_cents: 4_000_000, term_months: null, product_ids: ["fixed_10y"] })],
          "tool_use",
        ),
        say("These options use $30,000.00, the amount on the application.\nQuestion for you: Use $40,000 as the requested amount?"),
      ],
      [judged("pass")],
    );
    const lines = await turn("What if the project is $40K?");
    const options = lines.find((l) => l.type === "options");
    if (options?.type !== "options") throw new Error("no options line");
    expect(options.calculator_result.amount_cents).toBe(3_000_000);
    expect(options.inputs_source.amount).toBe("form");
    expect(options.calculator_result.options).toHaveLength(1);
    const result = JSON.parse(created[1].messages.at(-1).content[0].content);
    expect(result.notes[0]).toContain("$40,000.00");
    expect(types(lines)).toContain("explanation");
    const shown = lines.find((l) => l.type === "explanation");
    expect(shown?.type === "explanation" && shown.text).toBe("These options use $30,000.00, the amount on the application.");
    expect(shown?.type === "explanation" && shown.question).toBe("Use $40,000 as the requested amount?");
  });
});

describe("a question for the contractor", () => {
  const BODY = "Option A costs less per month and more over the life of the loan.";
  const QUESTION = "Use $40,000 as the requested amount?";
  const explanationOf = (lines: StreamLine[]) => {
    const line = lines.find((l) => l.type === "explanation");
    if (line?.type !== "explanation") throw new Error("no explanation line");
    return line;
  };

  it("splits a final Question for you line off the body after the whole draft passed", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    const { parsed } = scripted(
      [message([CALC_ALL], "tool_use"), say(`${BODY}\nQuestion for you: ${QUESTION}`)],
      [judged("pass")],
    );
    const lines = await turn("If she adds the solar panels it could come to $40K. What would the payment be then?");

    // The judge read the question with the rest of the draft.
    expect(JSON.stringify(parsed[0])).toContain(`Question for you: ${QUESTION}`);

    const shown = explanationOf(lines);
    expect(shown.text).toBe(BODY);
    expect(shown.question).toBe(QUESTION);
    expect(shown.footer).toBe(CHAT_FOOTER);
    expect(StreamLineSchema.safeParse(shown).success).toBe(true);

    // The record, and so the homeowner view, holds the body only; the audit keeps the question.
    const options = lines.find((l) => l.type === "options");
    if (options?.type !== "options") throw new Error("no options line");
    expect(store.getOptions(options.options_id)?.explanation).toBe(BODY);
    expect(ofType("options.explained")).toMatchObject([{ options_id: options.options_id, text: BODY, question: QUESTION }]);
    // The chat transcript keeps what the model wrote.
    expect(store.listMessages(APP).at(-1)?.text).toBe(`${BODY}\nQuestion for you: ${QUESTION}`);
  });

  it("records a null question when the draft has none", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    scripted([message([CALC_ALL], "tool_use"), say(BODY)], [judged("pass")]);
    const lines = await turn("Payments for $30K?");
    const shown = explanationOf(lines);
    expect(shown.text).toBe(BODY);
    expect(shown.question).toBeNull();
    expect(ofType("options.explained")[0]?.question).toBeNull();
  });

  it("treats a draft whose marker is not alone on the final line as having no question", async () => {
    const drafts = [
      `Question for you: ${QUESTION}\n${BODY}`, // the marker is not on the final line
      `${BODY} Question for you: ${QUESTION}`, // the final line does not start with the marker
      `Question for you: Which amount?\n${BODY}\nQuestion for you: ${QUESTION}`, // the marker appears twice
      `${BODY}\nQuestion for you: Which amount? Question for you: ${QUESTION}`, // twice on the final line
      `${BODY}\nQuestion for you:\n${QUESTION}`, // the question is on the line after the marker
    ];
    for (const draft of drafts) {
      store.reset();
      store.loadSeed();
      installAuditLog(createAuditLog(createMemorySink()));
      scripted([say(draft)], [judged("pass")]);
      const shown = explanationOf(await turn("Explain the options. It could come to $40K."));
      expect(shown.text, draft).toBe(draft);
      expect(shown.question, draft).toBeNull();
    }
  });

  it("splits a question only draft into a reply with no explanation to store", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    scripted([message([CALC_ALL], "tool_use"), say(`Question for you: ${QUESTION}`)], [judged("pass")]);
    const lines = await turn("Payments for $30K? It could come to $40K.");
    const shown = explanationOf(lines);
    expect(shown.text).toBe(QUESTION);
    expect(shown.question).toBeNull();
    const options = lines.find((l) => l.type === "options");
    if (options?.type !== "options") throw new Error("no options line");
    // Nothing for the homeowner view: it keeps its canned sentences.
    expect(store.getOptions(options.options_id)?.explanation).toBeUndefined();
    expect(ofType("options.explained")).toEqual([]);
  });

  it("drops a bare marker after the body and keeps the body", async () => {
    scripted([say(`${BODY}\nQuestion for you:`)], [judged("pass")]);
    const shown = explanationOf(await turn("Explain the options."));
    expect(shown.text).toBe(BODY);
    expect(shown.question).toBeNull();
  });

  it("blocks the whole draft when the question breaks a rule, and shows the regenerated reply", async () => {
    scripted(
      [
        say(`${BODY}\nQuestion for you: Should she be told she is pre-approved?`),
        say(`${BODY}\nQuestion for you: ${QUESTION}`),
      ],
      [judged("pass"), judged("pass")],
    );
    const lines = await turn("If she adds the solar panels it could come to $40K.");
    expect(ofType("guardrail.verdict").filter((v) => v.outcome === "blocked").map((v) => v.layer)).toContain("denylist");
    const shown = explanationOf(lines);
    expect(shown.text).toBe(BODY);
    expect(shown.question).toBe(QUESTION);
    expect(JSON.stringify(lines)).not.toContain("pre-approved");
  });
});

describe("splitQuestion", () => {
  it("returns the body and the question without the marker", () => {
    expect(splitQuestion("Option A is fixed.\n\nQuestion for you: Which amount?\n")).toEqual({
      body: "Option A is fixed.",
      question: "Which amount?",
    });
    expect(splitQuestion("Question for you: Which amount?")).toEqual({ body: "", question: "Which amount?" });
  });

  it("leaves a draft without a splittable marker as it is", () => {
    for (const draft of ["Option A is fixed.", "Question for you:", "Question for you: a\nOption A.", "Option A. Question for you: a"]) {
      expect(splitQuestion(draft)).toEqual({ body: draft, question: null });
    }
  });

  it("matches the marker exactly", () => {
    expect(splitQuestion("Option A.\nquestion for you: Which amount?")).toEqual({
      body: "Option A.\nquestion for you: Which amount?",
      question: null,
    });
  });
});

describe("the guardrail in a turn", () => {
  it("regenerates once with the reason, then shows the second draft", async () => {
    const { created } = scripted(
      [say("She is pre-approved for Option A."), say("Option A is a fixed-rate loan.")],
      [judged("block", "implied_approval", "Says she is pre-approved."), judged("pass")],
    );
    const lines = await turn("Tell her she's pre-approved for the 0% option.");

    expect(types(lines)).toEqual(["status", "status", "status", "status", "explanation", "done"]);
    const shown = lines.find((l) => l.type === "explanation");
    expect(shown?.type === "explanation" && shown.text).toBe("Option A is a fixed-rate loan.");
    expect(shown?.type === "explanation" && shown.footer).toBeNull();

    // All three checks ran on the blocked draft, and the denylist and the judge agreed.
    const verdicts = ofType("guardrail.verdict");
    expect(verdicts.map((v) => `${v.layer}:${v.outcome}`)).toEqual([
      "denylist:blocked",
      "number_match:pass",
      "judge:blocked",
      "denylist:pass",
      "number_match:pass",
      "judge:pass",
    ]);
    expect(verdicts[0]?.matched_terms).toEqual(["pre-approved"]);

    // The second request carries the blocked draft and the reason as a mid-turn instruction.
    const retry = created[1].messages;
    expect(retry.at(-2).role).toBe("assistant");
    expect(retry.at(-1).role).toBe("user");
    expect(retry.at(-1).content).toContain("The wording check blocked that draft");
    expect(retry.at(-1).content).toContain("pre-approved");

    // The blocked text is retained in the audit log.
    expect(JSON.stringify(ofType("model.call")[0]?.raw_output)).toContain("pre-approved");
  });

  it("falls back, with the marker and a link to the blocking verdict, after two blocks", async () => {
    scripted(
      [say("She is pre-approved."), say("She qualifies for the best rate.")],
      [judged("block", "implied_approval", "Implies approval."), judged("block", "implied_approval", "Implies approval.")],
    );
    const lines = await turn("Tell her she's pre-approved.");

    expect(types(lines)).toEqual(["status", "status", "status", "status", "fallback", "done"]);
    const fallback = lines.find((l) => l.type === "fallback");
    if (fallback?.type !== "fallback") throw new Error("no fallback line");
    expect(fallback.text).toBe(FALLBACK_REPLY);
    expect(fallback.marker).toBe(FALLBACK_MARKER);
    const target = events().find((e) => e.event_id === fallback.audit_event_id);
    expect(target?.type).toBe("guardrail.verdict");
    expect(target?.type === "guardrail.verdict" && target.outcome).toBe("blocked");
    expect(ofType("model.call").filter((c) => c.use_case === "copilot")).toHaveLength(2);
    expect(store.listMessages(APP).at(-1)).toMatchObject({ role: "assistant", text: FALLBACK_REPLY });
  });

  it("blocks an invented figure with the number-match check", async () => {
    scripted(
      [say("That is about $350 a month."), say("The payment depends on the amount and the product.")],
      [judged("pass"), judged("pass")],
    );
    const lines = await turn("What is the payment?");
    const verdicts = ofType("guardrail.verdict");
    expect(verdicts[1]).toMatchObject({ layer: "number_match", outcome: "blocked", matched_terms: ["$350.00"] });
    expect(verdicts[0]?.outcome).toBe("pass");
    expect(verdicts[2]?.outcome).toBe("pass");
    expect(types(lines)).toContain("explanation");
  });

  it("blocks one option's payment attached to another, using the last Options record's own figures", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    const { created } = scripted(
      [
        message([CALC_ALL], "tool_use"),
        say("Option A is $414.14 a month."),
        say("Option B is $414.14 a month after the first 18 months."),
      ],
      [judged("pass"), judged("pass")],
    );
    const lines = await turn("What would the monthly payment look like?");
    const verdicts = ofType("guardrail.verdict");
    expect(verdicts[1]).toMatchObject({ layer: "number_match", outcome: "blocked", matched_terms: ["$414.14"] });
    expect(verdicts[0]?.outcome).toBe("pass");
    expect(verdicts[2]?.outcome).toBe("pass");
    expect(created.at(-1).messages.at(-1).content).toContain("Option A");
    const shown = lines.find((l) => l.type === "explanation");
    expect(shown?.type === "explanation" && shown.text).toBe("Option B is $414.14 a month after the first 18 months.");
    expect(ofType("guardrail.verdict").slice(3).map((v) => v.outcome)).toEqual(["pass", "pass", "pass"]);
  });

  it("parents the judge's verdict to the judge's own model call, and the other verdicts to the draft", async () => {
    scripted([say("Option A is a fixed-rate loan.")], [judged("pass")]);
    await turn("Explain Option A.");
    const [copilotCall, judgeCall] = ofType("model.call");
    expect(copilotCall?.use_case).toBe("copilot");
    expect(judgeCall?.use_case).toBe("judge");
    expect(judgeCall?.parent_event_id).toBe(copilotCall?.event_id);
    const verdicts = ofType("guardrail.verdict");
    expect(verdicts.map((v) => v.layer)).toEqual(["denylist", "number_match", "judge"]);
    expect(verdicts[0]?.parent_event_id).toBe(copilotCall?.event_id);
    expect(verdicts[1]?.parent_event_id).toBe(copilotCall?.event_id);
    expect(verdicts[2]?.parent_event_id).toBe(judgeCall?.event_id);
  });

  it("parents a judge outage's verdict to the failed judge call", async () => {
    scripted([say("Option A is a fixed-rate loan.")], [new Error("judge is down")]);
    await turn("Explain Option A.");
    const judgeCall = ofType("model.call").find((c) => c.use_case === "judge");
    expect(judgeCall).toBeDefined();
    const judge = ofType("guardrail.verdict").find((v) => v.layer === "judge");
    expect(judge?.parent_event_id).toBe(judgeCall?.event_id);
  });

  it("records an empty draft as a block on every layer, then regenerates once", async () => {
    const { created } = scripted([say("  \n "), say("Option A is a fixed-rate loan.")], [judged("pass")]);
    const lines = await turn("Explain Option A.");

    const verdicts = ofType("guardrail.verdict");
    expect(verdicts.slice(0, 3).map((v) => [v.layer, v.verdict, v.outcome, v.rationale])).toEqual([
      ["denylist", "block", "blocked", "empty_draft"],
      ["number_match", "block", "blocked", "empty_draft"],
      ["judge", "block", "blocked", "empty_draft"],
    ]);
    // Every verdict that was shown to anyone is in the log, parented to the empty draft's model call.
    const draft = ofType("model.call")[0];
    for (const verdict of verdicts.slice(0, 3)) expect(verdict.parent_event_id).toBe(draft?.event_id);
    // The judge was not asked about nothing.
    expect(ofType("model.call").map((c) => c.use_case)).toEqual(["copilot", "copilot", "judge"]);
    expect(verdicts.slice(3).map((v) => v.outcome)).toEqual(["pass", "pass", "pass"]);

    // The regeneration request says why.
    expect(created).toHaveLength(2);
    expect(created[1].messages.at(-1).content).toContain("The reply was empty.");
    expect(created[1].messages.at(-1).content).not.toContain("empty_draft");
    const shown = lines.find((l) => l.type === "explanation");
    expect(shown?.type === "explanation" && shown.text).toBe("Option A is a fixed-rate loan.");
  });

  it("falls back, linked to a logged verdict, when the regenerated draft is empty too", async () => {
    scripted([message([], "end_turn"), say("")]);
    const lines = await turn("Explain Option A.");
    expect(types(lines)).toEqual(["status", "status", "status", "status", "fallback", "done"]);
    const fallback = lines.find((l) => l.type === "fallback");
    if (fallback?.type !== "fallback") throw new Error("no fallback line");
    const target = events().find((e) => e.event_id === fallback.audit_event_id);
    expect(target?.type).toBe("guardrail.verdict");
    expect(target?.type === "guardrail.verdict" && target.rationale).toBe("empty_draft");
    expect(ofType("guardrail.verdict")).toHaveLength(6);
    expect(ofType("model.call").map((c) => c.use_case)).toEqual(["copilot", "copilot"]);
  });

  it("treats a judge outage as a block with its own outcome and goes straight to the fallback", async () => {
    const { created } = scripted([say("Option A is a fixed-rate loan.")], [new Error("judge is down")]);
    const lines = await turn("Explain Option A.");

    expect(types(lines)).toEqual(["status", "status", "fallback", "done"]);
    const judge = ofType("guardrail.verdict").find((v) => v.layer === "judge");
    expect(judge).toMatchObject({ verdict: "block", outcome: "judge_unavailable" });
    expect(created).toHaveLength(1);
    const fallback = lines.find((l) => l.type === "fallback");
    expect(fallback?.type === "fallback" && fallback.audit_event_id).toBe(judge?.event_id);
  });

  it("fails closed on a judge reply that names a violation but says pass", async () => {
    scripted(
      [say("Option A is a fixed-rate loan."), say("Option A is a fixed-rate loan, as described.")],
      [judged("pass", "pressure", "Mild urgency."), judged("pass")],
    );
    const lines = await turn("Explain Option A.");
    expect(ofType("guardrail.verdict")[2]?.outcome).toBe("blocked");
    expect(types(lines)).toContain("explanation");
  });
});

describe("proposals", () => {
  it("drops a paraphrased quote, logs it, and tells the model", async () => {
    const { created } = scripted(
      [
        message(
          [
            toolUse("t1", "propose_field_fill", {
              field: "preferred_term_months",
              value: "120",
              message_id: "m_1",
              verbatim_quote: "she wants ten years",
            }),
          ],
          "tool_use",
        ),
        say("Nothing was suggested; is the term 10 years?"),
      ],
      [judged("pass")],
    );
    const lines = await turn("She wants the 10-year option");

    expect(types(lines)).not.toContain("proposals");
    expect(store.listProposals(APP)).toEqual([]);
    const dropped = ofType("field.proposed");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      proposal_id: null,
      dropped_reason: "quote_not_verified",
      field_key: "preferred_term_months",
    });
    const result = created[1].messages.at(-1).content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Not recorded");
  });

  it("drops a real quote that does not state the value proposed with it", async () => {
    const { created } = scripted(
      [
        message(
          [toolUse("t1", "propose_field_fill", { field: "project_amount", value: "$40K", message_id: "m_1", verbatim_quote: "$30K" })],
          "tool_use",
        ),
        say("Nothing was suggested; is the project $30K?"),
      ],
      [judged("pass")],
    );
    const lines = await turn("The project is $30K");

    expect(store.listProposals(APP)).toEqual([]);
    expect(ofType("field.proposed")).toHaveLength(1);
    expect(ofType("field.proposed")[0]).toMatchObject({
      proposal_id: null,
      field_key: "project_amount",
      value: "$40K",
      dropped_reason: "quote_not_verified",
      source: { kind: "message", ref: { message_id: "m_1", quote: "$30K" } },
    });
    expect(lines.find((l) => l.type === "proposals")).toEqual({
      type: "proposals",
      proposals: [],
      note: "I couldn't produce field suggestions for that; the explanation is below.",
    });
    const result = created[1].messages.at(-1).content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("does not state that value");
  });

  it("drops a name, ZIP or term the quote does not state, and keeps the ones it does", async () => {
    scripted(
      [
        message(
          [
            toolUse("t1", "propose_field_fill", { field: "homeowner_first_name", value: "Maria", message_id: "m_1", verbatim_quote: "Maria Lopez" }),
            toolUse("t2", "propose_field_fill", { field: "homeowner_last_name", value: "Lopez", message_id: "m_1", verbatim_quote: "Maria Lopez" }),
            toolUse("t3", "propose_field_fill", { field: "property_zip", value: "95113", message_id: "m_1", verbatim_quote: "zip 95112" }),
            toolUse("t4", "propose_field_fill", { field: "preferred_term_months", value: "180", message_id: "m_1", verbatim_quote: "the 10-year option" }),
            toolUse("t5", "propose_field_fill", { field: "preferred_term_months", value: "120", message_id: "m_1", verbatim_quote: "the 10-year option" }),
            toolUse("t6", "propose_field_fill", { field: "selected_product_id", value: "fixed_10y", message_id: "m_1", verbatim_quote: "the 10-year option" }),
            toolUse("t7", "propose_field_fill", { field: "selected_product_id", value: "deferred_12m", message_id: "m_1", verbatim_quote: "the 10-year option" }),
          ],
          "tool_use",
        ),
        say("Four values were suggested."),
      ],
      [judged("pass")],
    );
    const lines = await turn("Homeowner is Maria Lopez, zip 95112, she wants the 10-year option on the $30K.");
    const proposals = lines.find((l) => l.type === "proposals");
    if (proposals?.type !== "proposals") throw new Error("no proposals line");
    expect(proposals.proposals.map((p) => [p.field_key, p.value])).toEqual([
      ["homeowner_first_name", "Maria"],
      ["homeowner_last_name", "Lopez"],
      ["preferred_term_months", "120"],
      ["selected_product_id", "fixed_10y"],
    ]);
    expect(ofType("field.proposed").filter((e) => e.dropped_reason === "quote_not_verified").map((e) => e.field_key)).toEqual([
      "property_zip",
      "preferred_term_months",
      "selected_product_id",
    ]);
  });

  it("drops a quote cited from a message that does not exist", async () => {
    scripted(
      [
        message(
          [toolUse("t1", "propose_field_fill", { field: "project_type", value: "roofing", message_id: "m_99", verbatim_quote: "roofing" })],
          "tool_use",
        ),
        say("Nothing was suggested."),
      ],
      [judged("pass")],
    );
    await turn("It is a roofing job");
    expect(store.listProposals(APP)).toEqual([]);
    expect(ofType("field.proposed")[0]?.dropped_reason).toBe("quote_not_verified");
  });

  it("reports a value the form already holds as dropped by the command, not by the model", async () => {
    setFieldValue(ctx, "project_amount", 3_000_000);
    const { created } = scripted(
      [
        message(
          [toolUse("t1", "propose_field_fill", { field: "project_amount", value: "$30K", message_id: "m_1", verbatim_quote: "$30K" })],
          "tool_use",
        ),
        say("The form already holds that amount."),
      ],
      [judged("pass")],
    );
    const lines = await turn("The project is $30K");
    expect(types(lines)).not.toContain("proposals");
    expect(ofType("field.proposed").at(-1)?.dropped_reason).toBe("equals_confirmed");
    expect(created[1].messages.at(-1).content[0].content).toContain("already holds");
  });

  it("answers an unparseable value with the schema-invalid note on a proposals line", async () => {
    scripted(
      [
        message(
          [toolUse("t1", "propose_field_fill", { field: "property_zip", value: "ninety", message_id: "m_1", verbatim_quote: "ninety" })],
          "tool_use",
        ),
        say("The ZIP code needs five digits."),
      ],
      [judged("pass")],
    );
    const lines = await turn("The zip is ninety");
    const proposals = lines.find((l) => l.type === "proposals");
    expect(proposals).toEqual({
      type: "proposals",
      proposals: [],
      note: "I couldn't produce field suggestions for that; the explanation is below.",
    });
  });
});

describe("invalid tool arguments", () => {
  it("writes the schema-invalid note on a proposals line for bad calculator arguments, and tells the model", async () => {
    const { created } = scripted(
      [
        message(
          [toolUse("t1", "calculate_payment", { amount_cents: -5, term_months: null, product_ids: ["fixed_10y"] })],
          "tool_use",
        ),
        say("Which loan amount should the options use?"),
      ],
      [judged("pass")],
    );
    const lines = await turn("What would the payment be on minus five?");
    expect(types(lines)).toEqual(["status", "proposals", "status", "status", "explanation", "done"]);
    expect(lines.find((l) => l.type === "proposals")).toEqual({
      type: "proposals",
      proposals: [],
      note: new AppError("llm.schema_invalid").message,
    });
    expect(types(lines)).not.toContain("options");
    const result = created[1].messages.at(-1).content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("amount_cents");
  });
});

describe("an amount or term the calculator refuses", () => {
  const cases = [
    { name: "amount", args: { amount_cents: 20_000_000_000, term_months: null, product_ids: ["fixed_10y"] } },
    { name: "term", args: { amount_cents: 3_000_000, term_months: 5_000, product_ids: ["fixed_10y"] } },
  ];
  for (const { name, args } of cases) {
    it(`writes the calculator's own message as the note for an out-of-range ${name}`, async () => {
      const { created } = scripted(
        [message([toolUse("t1", "calculate_payment", args)], "tool_use"), say("The options need an amount and term in range.")],
        [judged("pass")],
      );
      const lines = await turn("What would the payment be on that?");
      expect(types(lines)).toEqual(["status", "status", "proposals", "status", "status", "explanation", "done"]);
      const result = created[1].messages.at(-1).content[0];
      expect(result.is_error).toBe(true);
      const proposals = lines.find((l) => l.type === "proposals");
      expect(proposals).toEqual({ type: "proposals", proposals: [], note: result.content });
      expect(result.content).not.toBe(new AppError("llm.schema_invalid").message);
      expect(proposals?.type === "proposals" && proposals.note).not.toMatch(/field suggestions/);
      expect(types(lines)).not.toContain("options");
    });
  }
});

describe("model failures", () => {
  it("treats a refusal as a block", async () => {
    scripted([message([], "refusal")]);
    const lines = await turn("Anything");
    expect(types(lines)).toEqual(["status", "fallback", "done"]);
    const modelCall = ofType("model.call")[0];
    expect(modelCall?.error_code).toBe("llm.refusal");
    const fallback = lines.find((l) => l.type === "fallback");
    expect(fallback?.type === "fallback" && fallback.audit_event_id).toBe(modelCall?.event_id);
  });

  it("treats a reply cut off at the token cap as a block", async () => {
    scripted([message([text("Option A is a fixed")], "max_tokens")]);
    const lines = await turn("Explain");
    expect(types(lines)).toEqual(["status", "fallback", "done"]);
  });

  it("treats a third round of tool use as a block", async () => {
    const again = (id: string) =>
      message(
        [toolUse(id, "propose_field_fill", { field: "project_type", value: "roofing", message_id: "m_1", verbatim_quote: "nope" })],
        "tool_use",
      );
    const { created } = scripted([again("a"), again("b"), again("c")]);
    const lines = await turn("It is roofing");
    expect(created).toHaveLength(3);
    expect(types(lines).filter((t) => t === "fallback")).toHaveLength(1);
    expect(types(lines).at(-1)).toBe("done");
  });

  it("maps a timeout to an error line, then done, and logs the failed call", async () => {
    scripted([new Anthropic.APIConnectionTimeoutError({ message: "timed out" })]);
    const lines = await turn("Hello");
    expect(lines.at(-2)).toMatchObject({ type: "error", code: "llm.timeout", retryable: true });
    expect(lines.at(-1)?.type).toBe("done");
    expect(ofType("model.call")[0]).toMatchObject({ error_code: "llm.timeout", stop_reason: null });
  });

  it("maps a rejected key to a non-retryable error", async () => {
    const rejected = Anthropic.APIError.generate(
      401,
      { error: { type: "authentication_error", message: "bad key" } },
      "bad key",
      new Headers(),
    );
    scripted([rejected]);
    const lines = await turn("Hello");
    expect(lines.at(-2)).toMatchObject({ type: "error", code: "llm.auth_failed", retryable: false });
  });

  it("writes an error line for a catalog fault and ends the turn", async () => {
    scripted([
      message([toolUse("t1", "calculate_payment", { amount_cents: 3_000_000, term_months: null, product_ids: [] })], "tool_use"),
    ]);
    // The catalog is read once for the prefix; fail the read.
    const original = services.catalog.getCatalog;
    services.catalog.getCatalog = async () => {
      throw new AppError("catalog.unavailable");
    };
    let lines: StreamLine[];
    try {
      lines = await turn("What is the payment on $30K?");
    } finally {
      services.catalog.getCatalog = original;
    }
    expect(lines.at(-2)).toMatchObject({ type: "error", code: "catalog.unavailable" });
    expect(lines.at(-1)?.type).toBe("done");
  });
});

describe("the context window", () => {
  it("keeps the last ten contractor turns and the replies between them", () => {
    const all = Array.from({ length: 12 }, (_, i) => [
      { id: `m_${2 * i + 1}`, role: "contractor" as const },
      { id: `m_${2 * i + 2}`, role: "assistant" as const },
    ]).flat();
    const messages = all.map((m) => ({
      ...m,
      application_id: APP,
      text: "x",
      ts: "2026-10-28T00:00:00.000Z",
      event_id: "e",
    }));
    const { kept, dropped } = splitWindow(messages);
    expect(kept.filter((m) => m.role === "contractor")).toHaveLength(TURN_WINDOW);
    expect(dropped.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3", "m_4"]);
    expect(kept[0]?.id).toBe("m_5");
  });

  it("appends one context.compacted event per message, once, when a message first leaves the window", async () => {
    const replies = Array.from({ length: 12 }, () => say("Option A is a fixed-rate loan."));
    scripted(replies, replies.map(() => judged("pass")));
    for (let i = 0; i < 12; i++) await turn(`Question number ${i + 1}`);
    const dropped = ofType("context.compacted").flatMap((e) => e.dropped_message_ids);
    expect(dropped).toEqual(["m_1", "m_2", "m_3", "m_4"]);
    expect(new Set(dropped).size).toBe(dropped.length);
  });
});

describe("base URL for the SDK", () => {
  it("drops a trailing /v1 because the SDK adds its own", () => {
    expect(sdkBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api");
    expect(sdkBaseUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api");
    expect(sdkBaseUrl("https://openrouter.ai/api")).toBe("https://openrouter.ai/api");
    expect(sdkBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com");
    expect(sdkBaseUrl(undefined)).toBeUndefined();
  });
});

describe("routes", () => {
  async function serve<T>(run: (base: string) => Promise<T>): Promise<T> {
    const app = express();
    app.use(createApiRouter());
    const server = app.listen(0);
    try {
      return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.close();
    }
  }
  const post = (base: string, path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "route-test" },
      body: JSON.stringify(body),
    });
  const ndjson = (body: string): StreamLine[] =>
    body
      .trim()
      .split("\n")
      .map((line) => StreamLineSchema.parse(JSON.parse(line)));

  it("streams newline-delimited JSON ending in done", async () => {
    scripted([say("Option A is a fixed-rate loan.")], [judged("pass")]);
    await serve(async (base) => {
      const res = await post(base, `/api/applications/${APP}/copilot/turns`, { text: "Explain Option A." });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const lines = ndjson(await res.text());
      expect(types(lines)).toEqual(["status", "status", "explanation", "done"]);
    });
    expect(events().every((e) => e.session_id === "route-test")).toBe(true);
  });

  it("answers copilot.disabled when the kill switch is off, without touching the transcript", async () => {
    vi.stubEnv("COPILOT_ENABLED", "false");
    await serve(async (base) => {
      const lines = ndjson(await (await post(base, `/api/applications/${APP}/copilot/turns`, { text: "Hi" })).text());
      expect(lines[0]).toMatchObject({ type: "error", code: "copilot.disabled", retryable: false });
      expect(lines.at(-1)).toEqual({ type: "done", event_ids: [] });
    });
    expect(store.listMessages(APP)).toEqual([]);
  });

  it("answers llm.missing_key when there is no key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await serve(async (base) => {
      const lines = ndjson(await (await post(base, `/api/applications/${APP}/copilot/turns`, { text: "Hi" })).text());
      expect(lines[0]).toMatchObject({ type: "error", code: "llm.missing_key" });
    });
  });

  it("rejects a bad body and an unknown application before streaming", async () => {
    await serve(async (base) => {
      expect((await post(base, `/api/applications/${APP}/copilot/turns`, { text: "  " })).status).toBe(400);
      expect((await post(base, "/api/applications/nope/copilot/turns", { text: "Hi" })).status).toBe(404);
    });
  });

  it("prices the three products with no model, then composes the homeowner view from the stored record", async () => {
    await serve(async (base) => {
      // Without a requested loan amount the button is refused.
      const refused = await post(base, `/api/applications/${APP}/copilot/payment-options`);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { message: string }).message).toBe("Confirm a requested loan amount first");

      setFieldValue(ctx, "requested_loan_amount", 3_000_000);
      const res = await post(base, `/api/applications/${APP}/copilot/payment-options`);
      expect(res.status).toBe(200);
      const line = OptionsLineSchema.parse(await res.json());
      expect(line.inputs_source).toEqual({ amount: "form", term: "catalog" });
      expect(line.calculator_result.options.map((o) => o.label)).toEqual(["Option A", "Option B", "Option C"]);
      expect(store.getOptions(line.options_id)?.explanation).toBeUndefined();
      const calc = ofType("tool.call").filter((c) => c.service === "calculator");
      expect(calc).toHaveLength(1);
      expect(calc[0]?._mock).toBeUndefined();

      // The homeowner view: no explanation, so the canned sentences; the disclosure block rides along.
      const view = await post(base, `/api/applications/${APP}/homeowner-view`, { options_id: line.options_id });
      expect(view.status).toBe(200);
      const props = HomeownerViewPropsSchema.parse(await view.json());
      expect(props.explanation).toBe(
        [CANNED_SENTENCE.fixed_10y, CANNED_SENTENCE.zero_intro_18m, CANNED_SENTENCE.deferred_12m].join(" "),
      );
      expect(props.mechanic_sentences).toEqual(CANNED_SENTENCE);
      expect(props.disclosure_block).toEqual(line.disclosure_block);
      expect(line.options_display).toHaveLength(3);
      expect(props.options_display).toEqual(line.options_display);
      expect(props.what_happens_next).toContain("Nothing is decided today");
      expect(props.template_version).toMatch(/^template@/);

      const rendered = ofType("view.rendered");
      expect(rendered).toHaveLength(1);
      expect(rendered[0]?.props).toEqual(props);
      expect(rendered[0]?.options_id).toBe(line.options_id);
      expect(rendered[0]?.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      // The button has no turn: the view was produced by the calculation and the storage of this record.
      const expected = events()
        .filter(
          (e) => (e.type === "tool.call" || e.type === "options.stored") && e.options_id === line.options_id,
        )
        .map((e) => e.event_id);
      expect(rendered[0]?.produced_by).toEqual(expected);
      expect(expected).toHaveLength(2);

      expect((await post(base, `/api/applications/${APP}/homeowner-view`, { options_id: "opt_999" })).status).toBe(404);
      expect((await post(base, `/api/applications/${APP}/homeowner-view`, {})).status).toBe(400);
    });
  });

  it("uses the judged explanation on the homeowner view when the turn produced one", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    const explanation = "Option A costs less per month and more over the life of the loan.";
    scripted([message([CALC_ALL], "tool_use"), say(explanation)], [judged("pass")]);
    await serve(async (base) => {
      const lines = ndjson(
        await (await post(base, `/api/applications/${APP}/copilot/turns`, { text: "Payments for $30K?" })).text(),
      );
      const options = lines.find((l) => l.type === "options");
      if (options?.type !== "options") throw new Error("no options line");
      const props = HomeownerViewPropsSchema.parse(
        await (await post(base, `/api/applications/${APP}/homeowner-view`, { options_id: options.options_id })).json(),
      );
      expect(props.explanation).toBe(explanation);
      const done = lines.at(-1);
      const rendered = ofType("view.rendered")[0];
      // Every event of the record's turn produced the view.
      const turnEvents = events()
        .filter((e) => e.turn_id !== undefined)
        .map((e) => e.event_id);
      expect(rendered?.produced_by).toEqual(turnEvents);
      expect(done?.type === "done" && done.event_ids).toEqual(turnEvents);
    });
  });

  it("keeps the contractor's question off the homeowner view", async () => {
    setFieldValue(ctx, "requested_loan_amount", 3_000_000);
    const body = "Option A costs less per month and more over the life of the loan.";
    scripted(
      [message([CALC_ALL], "tool_use"), say(`${body}\nQuestion for you: Use $40,000 as the requested amount?`)],
      [judged("pass")],
    );
    await serve(async (base) => {
      const lines = ndjson(
        await (await post(base, `/api/applications/${APP}/copilot/turns`, { text: "If she adds solar it could be $40K." })).text(),
      );
      const options = lines.find((l) => l.type === "options");
      const shown = lines.find((l) => l.type === "explanation");
      if (options?.type !== "options" || shown?.type !== "explanation") throw new Error("missing lines");
      expect(shown.question).toBe("Use $40,000 as the requested amount?");
      const res = await post(base, `/api/applications/${APP}/homeowner-view`, { options_id: options.options_id });
      const props = HomeownerViewPropsSchema.parse(await res.json());
      expect(props.explanation).toBe(body);
      const printed = JSON.stringify(props) + JSON.stringify(ofType("view.rendered"));
      expect(printed).not.toContain("Question for you");
      expect(printed).not.toContain("Use $40,000");
    });
  });

  it("lets the contractor edit a suggestion in place, once", async () => {
    scripted(
      [
        message(
          [
            toolUse("t1", "propose_field_fill", {
              field: "project_amount",
              value: "$30K",
              message_id: "m_1",
              verbatim_quote: "The project is $30K",
            }),
          ],
          "tool_use",
        ),
        say("A project amount was suggested."),
      ],
      [judged("pass")],
    );
    await serve(async (base) => {
      const lines = ndjson(
        await (await post(base, `/api/applications/${APP}/copilot/turns`, { text: "The project is $30K." })).text(),
      );
      const proposals = lines.find((l) => l.type === "proposals");
      if (proposals?.type !== "proposals") throw new Error("no proposals line");
      const pid = proposals.proposals[0]?.id ?? "";

      const bad = await post(base, `/api/applications/${APP}/proposals/${pid}/edit`, { value: "lots" });
      expect(bad.status).toBe(400);

      const edited = await post(base, `/api/applications/${APP}/proposals/${pid}/edit`, { value: "$35K" });
      expect(edited.status).toBe(200);
      const view = (await edited.json()) as { fields: Record<string, { value: number; state: string }> };
      expect(view.fields.project_amount).toMatchObject({ value: 3_500_000, state: "edited" });
      const event = ofType("field.edited")[0];
      expect(event).toMatchObject({ field_key: "project_amount", before: 3_000_000, after: 3_500_000 });

      // `edited` is terminal.
      expect((await post(base, `/api/applications/${APP}/proposals/${pid}/edit`, { value: "$36K" })).status).toBe(409);
      expect((await post(base, `/api/applications/${APP}/proposals/p_999/edit`, { value: "$36K" })).status).toBe(409);
    });
  });
});
