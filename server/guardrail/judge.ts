// The model check: Haiku classifies the draft against one fixed set of criteria (implied approval
// or likelihood, pressure, promo claims without the caveat, restated personal data). Fails closed:
// any error, a truncated reply or an unparseable one is `judge_unavailable`, never a pass.

import { readFileSync } from "node:fs";
import { z } from "zod/v4";
import type { Verdict } from "@shared/schemas";
import type { Ctx } from "../audit-log.js";
import { judgeCall } from "../llm/client.js";

// zodOutputFormat takes a zod v4 schema, which the installed zod 3.25 ships under "zod/v4".
export const JUDGE_CATEGORIES = ["implied_approval", "pressure", "uncaveated_promo", "personal_data", "none"] as const;

export const JudgeOutputSchema = z.object({
  verdict: z.enum(["pass", "block"]),
  category: z.enum(JUDGE_CATEGORIES),
  rationale: z.string(),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

let systemPrompt: string | undefined;

function judgePrompt(): string {
  systemPrompt ??= readFileSync(new URL("../prompts/judge.system.md", import.meta.url), "utf8").trim();
  return systemPrompt;
}

export interface JudgeResult {
  verdict: Verdict;
  /** The `model.call` event of the judge call, when one was made. */
  event_id?: string;
}

/** Judges one draft. Never throws: every failure is a `judge_unavailable` verdict. */
export async function runJudge(ctx: Ctx, text: string): Promise<JudgeResult> {
  const unavailable = (reason: string, event_id?: string): JudgeResult => ({
    verdict: { pass: false, layer: "judge", outcome: "judge_unavailable", reason },
    ...(event_id === undefined ? {} : { event_id }),
  });
  try {
    const result = await judgeCall(ctx, {
      system: judgePrompt(),
      prompt: `Evaluate this draft reply.\n\n<draft>\n${text}\n</draft>`,
      outputSchema: JudgeOutputSchema,
    });
    if (result.stop_reason === "max_tokens") {
      return unavailable("The wording check ran out of room before it finished.", result.event_id);
    }
    const out = result.parsed;
    if (!out) return unavailable("The wording check returned no usable verdict.", result.event_id);
    // A pass that names a violation contradicts itself; fail closed.
    const consistentPass = out.verdict === "pass" && out.category === "none";
    return {
      verdict: consistentPass
        ? { pass: true, layer: "judge", outcome: "pass", reason: out.rationale }
        : {
            pass: false,
            layer: "judge",
            outcome: "blocked",
            reason:
              out.verdict === "block"
                ? out.rationale || `The wording check flagged ${out.category}.`
                : `The wording check flagged ${out.category}: ${out.rationale}`,
            matched: out.category === "none" ? [] : [out.category],
          },
      event_id: result.event_id,
    };
  } catch (err) {
    const eventId = (err as { event_id?: unknown }).event_id;
    return unavailable(
      "The wording check could not run.",
      typeof eventId === "string" ? eventId : undefined,
    );
  }
}
