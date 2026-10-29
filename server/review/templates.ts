import { formatMoney } from "@shared/format";
import type { DiscrepancyReason, FlagReason } from "@shared/reason-codes";
import type { DiscrepancyRaiseInput } from "@shared/schemas";
import { CLARIFICATION_TEMPLATE } from "../guardrail/fallback.js";

// Clarification questions are templates per reason code and never model text: the question a
// reviewer sends to the contractor is one of these, filled with the two figures, then edited by
// the reviewer if they choose.

// The Compliance-owned wording lives in server/guardrail/fallback.ts, the one place that names
// every fixed text; this module fills it in and places it.
export { CLARIFICATION_TEMPLATE, LOCATED_ACK, NOT_LOCATED_CAPTION } from "../guardrail/fallback.js";

/** The label of each fixed reason a reviewer can flag a value with. */
export const FLAG_REASON_LABELS: Readonly<Record<FlagReason, string>> = {
  illegible: "Illegible",
  source_not_located: "Not found on the page",
  mismatch_with_stated: "Does not match the application",
  wrong_document_type: "Wrong document",
  missing: "Missing",
  pay_frequency_not_located: "Pay frequency not found",
  other: "Other",
};

/**
 * Flag reasons only the system writes. The review path rejects a calculated value with
 * `pay_frequency_not_located` when the pay frequency it needs is missing (server/review/derived.ts),
 * so a reviewer is never offered it: they flag the pay frequency row itself, and the system does the rest.
 */
export const SYSTEM_ONLY_FLAG_REASONS = ["pay_frequency_not_located"] as const satisfies readonly FlagReason[];

/** A flag reason a reviewer may choose. */
export type ReviewerFlagReason = Exclude<FlagReason, (typeof SYSTEM_ONLY_FLAG_REASONS)[number]>;

/** The labels of the reasons a reviewer may flag a value with, in the order the screen lists them. */
export function reviewerFlagReasonLabels(): Record<ReviewerFlagReason, string> {
  const system: readonly string[] = SYSTEM_ONLY_FLAG_REASONS;
  return Object.fromEntries(
    Object.entries(FLAG_REASON_LABELS).filter(([code]) => !system.includes(code)),
  ) as Record<ReviewerFlagReason, string>;
}

function money(value: unknown): string {
  if (typeof value !== "number") throw new TypeError("A clarification question needs two money values in cents.");
  return formatMoney(value);
}

/**
 * Fills the template for `reason` with the stated and the extracted value, both integer cents,
 * through `formatMoney`.
 */
export function renderQuestion(
  reason: DiscrepancyReason,
  record: { stated: Pick<DiscrepancyRaiseInput["stated"], "value">; extracted: Pick<DiscrepancyRaiseInput["extracted"], "value"> },
): string {
  return CLARIFICATION_TEMPLATE[reason]
    .replace("{stated}", money(record.stated.value))
    .replace("{extracted}", money(record.extracted.value));
}
