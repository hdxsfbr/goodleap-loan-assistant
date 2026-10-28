import type { Banner, DiscrepancyRecord } from "@shared/schemas";

// The contractor-facing "needs clarification" banner. It is computed from the discrepancy records
// and never stored. server/guardrail/fallback.ts re-exports this constant so the Compliance-owned
// fixed texts still have one definition.
export const BANNER_TEXT =
  "Needs clarification: a reviewer found a difference between a document and the application and has sent a question. No decision has been made.";

/**
 * The banner for an application: shown only while a record is `open` and its question has been
 * sent, so raising a record does not alert the contractor before the reviewer has sent it. With
 * several such records it carries the one sent first.
 */
export function deriveBanner(records: readonly DiscrepancyRecord[]): Banner | null {
  const sent = records
    .filter((record) => record.status === "open" && record.sent_at !== undefined)
    .sort((a, b) => (a.sent_at ?? "").localeCompare(b.sent_at ?? ""));
  const first = sent[0];
  if (!first) return null;
  return {
    text: BANNER_TEXT,
    question: first.question.text,
    record_id: first.id,
    contractor_reply: first.contractor_reply?.text ?? null,
  };
}
