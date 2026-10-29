// The guardrail contract and its orchestrator. Three checks run on every draft, in this order:
// deny-list, number-match, judge. Any block is final; the regenerate-once-then-fallback logic
// lives in server/copilot/turn.ts. A judge that cannot run is a block with its own outcome.

import type { ErrorCode, GuardrailAllowed, Verdict } from "@shared/schemas";
import { audit, type Ctx } from "../audit-log.js";
import { checkDenylist } from "./denylist.js";
import { runJudge } from "./judge.js";
import { checkNumberMatch } from "./number-match.js";

/** The contract of one check: model prose and the figures it may use in, a verdict out. */
export interface GuardrailCheck {
  check(text: string, allowed: GuardrailAllowed): Verdict | Promise<Verdict>;
}

/** The rationale recorded on each layer's verdict when a draft has no text at all. */
export const EMPTY_DRAFT_REASON = "empty_draft";

export const denylistCheck: GuardrailCheck = { check: (text) => checkDenylist(text) };
export const numberMatchCheck: GuardrailCheck = { check: (text, allowed) => checkNumberMatch(text, allowed) };

export interface GuardrailResult {
  pass: boolean;
  /** Set when the judge could not run: the draft is withheld and the outcome is distinct. */
  code?: Extract<ErrorCode, "guardrail.judge_unavailable">;
  /** One verdict per check, in order: deny-list, number-match, judge. */
  verdicts: Verdict[];
  /** Every blocking reason, so a disagreement between checks is visible in both directions. */
  reasons: string[];
  /** The `guardrail.verdict` events appended, in the order of `verdicts`. */
  event_ids: string[];
  /** The first blocking verdict's event, the target of the fallback's audit link. */
  blocking_event_id?: string;
}

/**
 * Runs all three checks on a draft and appends one `guardrail.verdict` event per check. `ctx`
 * carries the turn and the draft's `model.call` event as the parent; the judge's verdict is the
 * child of the judge's own `model.call`, so its rationale walks up to the call that produced it.
 * A draft with no text is a block on every layer, recorded as such with the rationale
 * `empty_draft`; the judge is not called for it.
 */
export async function runGuardrail(ctx: Ctx, text: string, allowed: GuardrailAllowed): Promise<GuardrailResult> {
  const systemCtx: Ctx = { ...ctx, actor: { type: "system", id: "guardrail" } };
  const verdicts: Verdict[] = [];
  const event_ids: string[] = [];

  const record = (verdict: Verdict, started: number, parent_event_id?: string): void => {
    const event = audit.emit(parent_event_id === undefined ? systemCtx : { ...systemCtx, parent_event_id }, "guardrail.verdict", {
      layer: verdict.layer,
      verdict: verdict.pass ? "pass" : "block",
      ...(verdict.matched && verdict.matched.length > 0 ? { matched_terms: verdict.matched } : {}),
      ...(verdict.reason === undefined ? {} : { rationale: verdict.reason }),
      outcome: verdict.outcome,
      latency_ms: Math.round((performance.now() - started) * 1000) / 1000,
    });
    verdicts.push(verdict);
    event_ids.push(event.event_id);
  };

  let started = performance.now();
  if (text.trim() === "") {
    for (const layer of ["denylist", "number_match", "judge"] as const) {
      record({ pass: false, layer, outcome: "blocked", reason: EMPTY_DRAFT_REASON }, started);
    }
    return {
      pass: false,
      verdicts,
      reasons: [EMPTY_DRAFT_REASON],
      event_ids,
      blocking_event_id: event_ids[0] as string,
    };
  }

  record(await denylistCheck.check(text, allowed), started);
  started = performance.now();
  record(await numberMatchCheck.check(text, allowed), started);
  started = performance.now();
  const judged = await runJudge(ctx, text);
  record(judged.verdict, started, judged.event_id);

  const blockingIndex = verdicts.findIndex((verdict) => !verdict.pass);
  const unavailable = verdicts.some((verdict) => verdict.outcome === "judge_unavailable");
  return {
    pass: blockingIndex === -1,
    ...(unavailable ? { code: "guardrail.judge_unavailable" as const } : {}),
    verdicts,
    reasons: verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.reason ?? verdict.layer),
    event_ids,
    ...(blockingIndex === -1 ? {} : { blocking_event_id: event_ids[blockingIndex] as string }),
  };
}
