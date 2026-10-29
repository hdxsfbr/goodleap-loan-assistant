// The eval runner (design item 72, Technical Plan section 12). It makes real model calls.
//
//   npm run eval                      the 15 copilot cases through runTurn, in process
//   npm run eval -- --judge           ... and the 20 labeled judge cases through the judge
//   npm run eval -- --judge-only      only the judge cases
//   npm run eval -- --only <id>       one copilot case or one judge case
//   npm run eval -- --json <path>     also write the full results (every stream line, draft, tool
//                                     call, verdict and the model's own output) to <path>
//   npm run eval -- --retries <n>     reruns of a case after infrastructure trouble only: a timeout,
//                                     a rate limit, a server error or an unavailable judge (default 1)
//   npm run eval -- --list            print the case ids and exit (no key needed)
//
// Each copilot case runs in a fresh in-memory world (the world the tests use: the seed, a memory
// audit log), sets the case's form values, then sends its messages in order as separate turns. The
// expectations are the design's (tests/eval/cases.json): a case the real model does not satisfy is a
// failure, reported with what the model actually did, never a loosened expectation.
//
// Exit code: 0 all cases passed and the judge thresholds were met; 1 a case failed or a threshold
// was missed; 2 nothing ran (no key, bad arguments, an invalid dataset).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AuditEvent, StreamLine } from "@shared/schemas";
import { audit, createAuditLog, createMemorySink, installAuditLog, type Ctx } from "../server/audit-log.js";
import { setFieldValue } from "../server/commands.js";
import { config, useCases } from "../server/config.js";
import { runTurn } from "../server/copilot/turn.js";
import { runJudge } from "../server/guardrail/judge.js";
import { loadEnvFile } from "../server/load-env.js";
import { store } from "../server/store.js";
import { getVersions } from "../server/versions.js";
import {
  EvalCasesFileSchema,
  JudgeCasesFileSchema,
  evaluateCase,
  guardrailPath,
  observeTurn,
  outcomeOf,
  scoreJudge,
  transientTrouble,
  type CaseOutcome,
  type EvalCase,
  type Failure,
  type JudgeCase,
  type JudgeScore,
  type JudgeVerdictKind,
  type ObservedTurn,
} from "./eval-schema.js";

loadEnvFile();

const CASES_PATH = fileURLToPath(new URL("../tests/eval/cases.json", import.meta.url));
const JUDGE_CASES_PATH = fileURLToPath(new URL("../tests/eval/judge-cases.json", import.meta.url));

const APPLICATION_ID = "app_demo_001";
const CONTRACTOR_ID = "ctr_demo_001";
const JUDGE_CONCURRENCY = 4;

// ---------------------------------------------------------------------------------------------
// Arguments and datasets
// ---------------------------------------------------------------------------------------------

interface Args {
  judge: boolean;
  judgeOnly: boolean;
  only: string | undefined;
  json: string | undefined;
  retries: number;
  list: boolean;
}

const USAGE =
  "Usage: npm run eval -- [--judge | --judge-only] [--only <id>] [--json <path>] [--retries <n>] [--list]";

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { judge: false, judgeOnly: false, only: undefined, json: undefined, retries: 1, list: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string | undefined => argv[++i];
    if (flag === "--judge") args.judge = true;
    else if (flag === "--judge-only") args.judgeOnly = true;
    else if (flag === "--list") args.list = true;
    else if (flag === "--only") {
      args.only = value();
      if (!args.only) return "--only needs a case id";
    } else if (flag === "--json") {
      args.json = value();
      if (!args.json) return "--json needs a path";
    } else if (flag === "--retries") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0 || n > 5) return "--retries needs a whole number from 0 to 5";
      args.retries = n;
    } else return `unknown argument ${flag}`;
  }
  return args;
}

function loadDataset<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`${path} is not a valid dataset:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------------------------

interface Usage {
  calls: number;
  input: number;
  output: number;
  cache_read: number;
}

const zeroUsage = (): Usage => ({ calls: 0, input: 0, output: 0, cache_read: 0 });

function addUsage(into: Usage, from: Usage): void {
  into.calls += from.calls;
  into.input += from.input;
  into.output += from.output;
  into.cache_read += from.cache_read;
}

type ModelCallEvent = Extract<AuditEvent, { type: "model.call" }>;

const modelCallsOf = (events: readonly AuditEvent[]): ModelCallEvent[] =>
  events.filter((event): event is ModelCallEvent => event.type === "model.call");

function usageOf(calls: readonly ModelCallEvent[]): Usage {
  const total = zeroUsage();
  for (const call of calls) {
    total.calls += 1;
    total.input += call.usage.input;
    total.output += call.usage.output;
    total.cache_read += call.usage.cache_read;
  }
  return total;
}

/** A model call as the results file keeps it: what was asked for and what the model actually said. */
function modelCallRecord(call: ModelCallEvent) {
  const content = (call.raw_output as { content?: unknown } | null)?.content;
  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  return {
    use_case: call.use_case,
    model_id: call.model_id,
    stop_reason: call.stop_reason,
    latency_ms: Math.round(call.latency_ms),
    usage: call.usage,
    ...(call.error_code === undefined ? {} : { error_code: call.error_code }),
    text: blocks.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n\n"),
    tool_uses: blocks.flatMap((b) => (b.type === "tool_use" ? [{ name: b.name, input: b.input }] : [])),
  };
}

/** The options line carries three full schedules; the results file keeps its identity and the table, not the rows. */
function slimLine(line: StreamLine): unknown {
  if (line.type !== "options") return line;
  return {
    type: "options",
    options_id: line.options_id,
    inputs_echo: line.inputs_echo,
    inputs_source: line.inputs_source,
    argument_label: line.argument_label,
    options_display: line.options_display,
    footer: line.footer,
    omitted: ["calculator_result", "disclosure_block"],
  };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const count = (n: number): string => n.toLocaleString("en-US");
const tokens = (u: Usage): string => `in ${count(u.input)} cache ${count(u.cache_read)} out ${count(u.output)}`;
const clip = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

// ---------------------------------------------------------------------------------------------
// Copilot cases
// ---------------------------------------------------------------------------------------------

interface TurnRecord {
  contractor_text: string;
  latency_ms: number;
  lines: unknown[];
  model_calls: ReturnType<typeof modelCallRecord>[];
  tool_calls: ObservedTurn["tool_calls"];
  proposal_attempts: ObservedTurn["attempts"];
  proposals: ObservedTurn["proposals"];
  verdicts: ObservedTurn["verdicts"];
  drafts: string[];
  shown: ObservedTurn["final"];
  errors: ObservedTurn["errors"];
}

interface RunOnce {
  turns: ObservedTurn[];
  records: TurnRecord[];
  usage: Usage;
  judge_usage: Usage;
  latency_ms: number;
}

/** One pass over a case in a fresh world: the form values, then each message as its own turn. */
async function runOnce(c: EvalCase): Promise<RunOnce> {
  store.reset();
  store.loadSeed();
  installAuditLog(createAuditLog(createMemorySink()));
  const ctx: Ctx = {
    application_id: APPLICATION_ID,
    session_id: `eval-${c.id}`,
    actor: { type: "contractor", id: CONTRACTOR_ID },
  };
  for (const [field, value] of Object.entries(c.form)) setFieldValue(ctx, field, value);

  const turns: ObservedTurn[] = [];
  const records: TurnRecord[] = [];
  const copilotUsage = zeroUsage();
  const judgeUsage = zeroUsage();
  let latency_ms = 0;

  for (const text of c.messages) {
    const lines: StreamLine[] = [];
    const started = performance.now();
    await runTurn(ctx, text, (line) => lines.push(line));
    const elapsed = performance.now() - started;
    latency_ms += elapsed;

    // The events this turn wrote are the ones its `done` line lists.
    const done = lines.findLast((line) => line.type === "done");
    const wanted = new Set(done?.type === "done" ? done.event_ids : []);
    const events = audit.list(APPLICATION_ID).filter((event) => wanted.has(event.event_id));
    const observed = observeTurn(text, lines, events);
    turns.push(observed);

    const calls = modelCallsOf(events);
    addUsage(copilotUsage, usageOf(calls.filter((call) => call.use_case === "copilot")));
    addUsage(judgeUsage, usageOf(calls.filter((call) => call.use_case === "judge")));
    records.push({
      contractor_text: text,
      latency_ms: Math.round(elapsed),
      lines: lines.map(slimLine),
      model_calls: calls.map(modelCallRecord),
      tool_calls: observed.tool_calls,
      proposal_attempts: observed.attempts,
      proposals: observed.proposals,
      verdicts: observed.verdicts,
      drafts: observed.drafts,
      shown: observed.final,
      errors: observed.errors,
    });
  }
  return { turns, records, usage: copilotUsage, judge_usage: judgeUsage, latency_ms };
}

interface CaseResult {
  id: string;
  category: string;
  description: string;
  passed: boolean;
  failures: Failure[];
  outcome: CaseOutcome;
  /** For a case that expects `blocked_or_declined`: how the conversation stayed clean. */
  guardrail_path?: string;
  latency_ms: number;
  /** Copilot calls and tokens; the judge's own are under `judge_usage`. */
  usage: Usage;
  judge_usage: Usage;
  /** Passes over the case, more than one only after infrastructure trouble. */
  runs: number;
  discarded_runs: { trouble: string; failures: Failure[] }[];
  messages: string[];
  form: EvalCase["form"];
  turns: TurnRecord[];
}

async function runCase(c: EvalCase, retries: number): Promise<CaseResult> {
  const discarded: CaseResult["discarded_runs"] = [];
  const spent = zeroUsage();
  const spentJudge = zeroUsage();
  let spentMs = 0;
  for (let attempt = 0; ; attempt++) {
    let run: RunOnce;
    try {
      run = await runOnce(c);
    } catch (err) {
      // A setup fault (a form value the world refuses) is a failed case, not a crashed run.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        id: c.id,
        category: c.category,
        description: c.description,
        passed: false,
        failures: [{ check: "setup", reason }],
        outcome: "none",
        latency_ms: Math.round(spentMs),
        usage: spent,
        judge_usage: spentJudge,
        runs: attempt + 1,
        discarded_runs: discarded,
        messages: c.messages,
        form: c.form,
        turns: [],
      };
    }
    addUsage(spent, run.usage);
    addUsage(spentJudge, run.judge_usage);
    spentMs += run.latency_ms;
    const failures = evaluateCase(c, run.turns);
    const trouble = transientTrouble(run.turns);
    if (trouble !== null && attempt < retries) {
      discarded.push({ trouble, failures });
      continue;
    }
    return {
      id: c.id,
      category: c.category,
      description: c.description,
      passed: failures.length === 0,
      failures,
      outcome: outcomeOf(run.turns),
      ...(c.expect.guardrail.blocked_or_declined ? { guardrail_path: guardrailPath(run.turns) } : {}),
      latency_ms: Math.round(spentMs),
      usage: spent,
      judge_usage: spentJudge,
      runs: attempt + 1,
      discarded_runs: discarded,
      messages: c.messages,
      form: c.form,
      turns: run.records,
    };
  }
}

function printCase(result: CaseResult): void {
  const total = zeroUsage();
  addUsage(total, result.usage);
  addUsage(total, result.judge_usage);
  console.log(
    `${result.passed ? "PASS" : "FAIL"}  ${result.id.padEnd(32)} ${result.category.padEnd(12)} ${result.outcome.padEnd(31)} ` +
      `${seconds(result.latency_ms).padStart(6)}  calls ${total.calls}  ${tokens(total)}` +
      (result.runs > 1 ? `  (rerun after ${result.discarded_runs.map((d) => d.trouble).join("; ")})` : ""),
  );
  if (result.guardrail_path) console.log(`        path: ${result.guardrail_path}`);
  for (const failure of result.failures) console.log(`        - ${failure.check}: ${failure.reason}`);
}

// ---------------------------------------------------------------------------------------------
// Judge cases
// ---------------------------------------------------------------------------------------------

interface JudgeCaseResult {
  id: string;
  label: JudgeCase["label"];
  category: JudgeCase["category"];
  verdict: JudgeVerdictKind;
  /** The category the judge gave a block (`none` for a pass). */
  judge_category: string;
  rationale: string;
  correct: boolean;
  latency_ms: number;
  usage: Usage;
  text: string;
  raw_output: unknown;
}

async function runJudgeCases(cases: readonly JudgeCase[]): Promise<{ results: JudgeCaseResult[]; score: JudgeScore; usage: Usage }> {
  installAuditLog(createAuditLog(createMemorySink()));
  const ctx: Ctx = { application_id: "eval-judge", session_id: "eval-judge", actor: { type: "system", id: "eval" } };

  // Independent calls: a few at a time. The rows are kept in dataset order.
  const queue = cases.map((c, index) => ({ c, index }));
  const rows: { case: JudgeCase; verdict: JudgeVerdictKind; category: string; rationale: string; latency_ms: number; event_id: string | undefined }[] = [];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const started = performance.now();
      const judged = await runJudge(ctx, next.c.text);
      const verdict: JudgeVerdictKind =
        judged.verdict.outcome === "pass" ? "pass" : judged.verdict.outcome === "blocked" ? "block" : "unavailable";
      rows[next.index] = {
        case: next.c,
        verdict,
        category: verdict === "block" ? (judged.verdict.matched?.[0] ?? "none") : "none",
        rationale: judged.verdict.reason ?? "",
        latency_ms: Math.round(performance.now() - started),
        event_id: judged.event_id,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, cases.length) }, worker));

  const events = new Map(modelCallsOf(audit.list("eval-judge")).map((event) => [event.event_id, event]));
  const usage = zeroUsage();
  const results: JudgeCaseResult[] = rows.map((row) => {
    const event = row.event_id === undefined ? undefined : events.get(row.event_id);
    const own = event ? usageOf([event]) : zeroUsage();
    addUsage(usage, own);
    const expected = row.case.label === "non_compliant" ? "block" : "pass";
    return {
      id: row.case.id,
      label: row.case.label,
      category: row.case.category,
      verdict: row.verdict,
      judge_category: row.category,
      rationale: row.rationale,
      correct: row.verdict === expected,
      latency_ms: row.latency_ms,
      usage: own,
      text: row.case.text,
      raw_output: event ? modelCallRecord(event) : null,
    };
  });
  return { results, score: scoreJudge(results), usage };
}

function printJudgeCase(r: JudgeCaseResult): void {
  const verdict = r.verdict === "block" ? `block (${r.judge_category})` : r.verdict;
  console.log(
    `${r.correct ? "PASS" : "FAIL"}  ${r.id.padEnd(40)} ${r.label.padEnd(13)} ${r.category.padEnd(24)} -> ${verdict.padEnd(28)} ` +
      `${seconds(r.latency_ms).padStart(5)}  ${tokens(r.usage)}`,
  );
  if (!r.correct) console.log(`        - judged ${r.verdict} for a ${r.label} output: ${clip(r.rationale)}`);
}

function printJudgeScore(score: JudgeScore): void {
  const { non_compliant: bad, compliant: good, required } = score;
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  // The stated thresholds are 0.95 and 5%. Below 20 per class one outcome is already 10% or more,
  // so the design's allowance is applied instead, and the line says so rather than claiming 5%.
  const recallRule =
    required.recall_basis === "small_set"
      ? `allowance used: at most 1 miss (at least ${required.min_caught} of ${bad.total}); the stated ${required.recall.toFixed(2)} cannot be measured below 20 per class`
      : `threshold >= ${required.recall.toFixed(2)} (at least ${required.min_caught} of ${bad.total})`;
  const falsePositiveRule =
    required.false_positive_basis === "small_set"
      ? `allowance used: at most 1 false positive (at most ${required.max_false_positives} of ${good.total}); the stated ${pct(required.false_positive_rate)} cannot be measured below 20 per class`
      : `threshold <= ${pct(required.false_positive_rate)} (at most ${required.max_false_positives} of ${good.total})`;
  console.log("\nJudge");
  console.log(
    `  recall on non-compliant:        ${bad.caught} of ${bad.total} = ${bad.recall.toFixed(2)} measured; ${recallRule}   ` +
      `${bad.caught >= required.min_caught ? "ok" : "MISSED"}`,
  );
  console.log(
    `  false positives on compliant:   ${good.false_positives} of ${good.total} = ${pct(good.false_positive_rate)} measured; ${falsePositiveRule}   ` +
      `${good.false_positives <= required.max_false_positives ? "ok" : "MISSED"}`,
  );
  if (score.incomplete) {
    console.log(`  the judge could not classify ${bad.unavailable + good.unavailable} output(s): the measurement is incomplete, run it again`);
  }
  console.log(`  judge set: ${score.passed ? "PASS" : "FAIL"}`);
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(`${args}\n${USAGE}`);
    return 2;
  }

  let cases: EvalCase[];
  let judgeCases: JudgeCase[];
  try {
    cases = loadDataset(CASES_PATH, EvalCasesFileSchema);
    judgeCases = loadDataset(JUDGE_CASES_PATH, JudgeCasesFileSchema);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  if (args.list) {
    for (const c of cases) console.log(`${c.id.padEnd(34)} ${c.category.padEnd(13)} ${c.messages.length} message(s)`);
    for (const j of judgeCases) console.log(`${j.id.padEnd(40)} judge ${j.label} / ${j.category}`);
    return 0;
  }

  if (!config.hasLlmKey) {
    console.log(
      "SKIP  no ANTHROPIC_API_KEY is set (add it to .env). The eval makes real model calls, so nothing was run.",
    );
    return 2;
  }

  // Which cases run.
  let selectedCases = cases;
  let selectedJudge: JudgeCase[] = args.judge || args.judgeOnly ? judgeCases : [];
  if (args.only !== undefined) {
    selectedCases = cases.filter((c) => c.id === args.only);
    selectedJudge = judgeCases.filter((j) => j.id === args.only);
    if (selectedCases.length + selectedJudge.length === 0) {
      console.error(`No case has the id ${args.only}. Run with --list to see them.`);
      return 2;
    }
  } else if (args.judgeOnly) {
    selectedCases = [];
  }

  const versions = getVersions();
  const models = useCases();
  const host = config.llmBaseUrl ? new URL(config.llmBaseUrl).host : "api.anthropic.com";
  console.log(`Endpoint: ${host}`);
  console.log(`Models: copilot=${models.copilot.model} judge=${models.judge.model}`);
  console.log(
    `Versions: ${versions.copilot_prompt} ${versions.judge_prompt} ${versions.denylist} ${versions.catalog} ${versions.fallback_texts} git=${versions.git_sha.slice(0, 8)}`,
  );
  console.log(`Cases: ${selectedCases.length} copilot, ${selectedJudge.length} judge\n`);

  const started = performance.now();
  const startedAt = new Date().toISOString();
  const copilotUsage = zeroUsage();
  const judgeInTurns = zeroUsage();

  const caseResults: CaseResult[] = [];
  if (selectedCases.length > 0) console.log("Copilot behavior");
  for (const c of selectedCases) {
    const result = await runCase(c, args.retries);
    caseResults.push(result);
    addUsage(copilotUsage, result.usage);
    addUsage(judgeInTurns, result.judge_usage);
    printCase(result);
  }

  let judgeRun: Awaited<ReturnType<typeof runJudgeCases>> | undefined;
  if (selectedJudge.length > 0) {
    console.log("\nJudge cases");
    judgeRun = await runJudgeCases(selectedJudge);
    for (const r of judgeRun.results) printJudgeCase(r);
    if (args.only === undefined) printJudgeScore(judgeRun.score);
  }

  // Summary.
  const passed = caseResults.filter((r) => r.passed).length;
  const judgeUsage = zeroUsage();
  addUsage(judgeUsage, judgeInTurns);
  if (judgeRun) addUsage(judgeUsage, judgeRun.usage);
  const wallMs = performance.now() - started;
  console.log("\nSummary");
  if (caseResults.length > 0) {
    console.log(`  copilot cases: ${passed} of ${caseResults.length} passed`);
    const failed = caseResults.filter((r) => !r.passed);
    for (const r of failed) console.log(`    FAIL ${r.id}: ${[...new Set(r.failures.map((f) => f.check))].join(", ")}`);
  }
  if (judgeRun && args.only === undefined) {
    console.log(`  judge set: ${judgeRun.score.passed ? "PASS" : "FAIL"}`);
  } else if (judgeRun) {
    const r = judgeRun.results[0];
    console.log(`  judge case: ${r?.correct ? "PASS" : "FAIL"}`);
  }
  console.log(`  model calls: copilot ${copilotUsage.calls}, judge ${judgeUsage.calls} (${copilotUsage.calls + judgeUsage.calls} total)`);
  console.log(
    `  tokens: in ${count(copilotUsage.input + judgeUsage.input)}, cache read ${count(copilotUsage.cache_read + judgeUsage.cache_read)}, out ${count(copilotUsage.output + judgeUsage.output)}`,
  );
  console.log(`  wall time: ${seconds(wallMs)}`);

  const ok = passed === caseResults.length && (judgeRun === undefined || (args.only !== undefined ? judgeRun.results.every((r) => r.correct) : judgeRun.score.passed));
  console.log(`\n${ok ? "All checks passed." : "Some checks failed."}`);

  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true });
    writeFileSync(
      args.json,
      `${JSON.stringify(
        {
          run: {
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            wall_ms: Math.round(wallMs),
            endpoint_host: host,
            models: { copilot: models.copilot.model, judge: models.judge.model },
            versions,
            arguments: process.argv.slice(2),
          },
          totals: {
            copilot: copilotUsage,
            judge: judgeUsage,
            model_calls: copilotUsage.calls + judgeUsage.calls,
          },
          copilot: {
            total: caseResults.length,
            passed,
            cases: caseResults,
          },
          judge: judgeRun
            ? { score: judgeRun.score, usage: judgeRun.usage, cases: judgeRun.results }
            : null,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Results written to ${args.json}`);
  }
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL  eval script error:", err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
