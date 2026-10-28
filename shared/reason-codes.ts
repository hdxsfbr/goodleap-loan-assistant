import { z } from "zod";

// Reason codes used by the value commands (flag and dismiss) and by the discrepancy engine.
// Imported by server/commands.ts, so this file stays free of any other project import.

/** Why a reviewer flagged a value instead of confirming it. */
export const FlagReasonSchema = z.enum([
  "illegible",
  "source_not_located",
  "mismatch_with_stated",
  "wrong_document_type",
  "missing",
  "pay_frequency_not_located",
  "other",
]);
export type FlagReason = z.infer<typeof FlagReasonSchema>;

/** Why a document value differs from the application in a way that needs a question. */
export const DiscrepancyReasonSchema = z.enum([
  "income_outside_tolerance",
  "requested_amount_over_estimate",
]);
export type DiscrepancyReason = z.infer<typeof DiscrepancyReasonSchema>;

/** Why a contractor dismissed a proposed value. */
export const ContractorRejectReasonSchema = z.enum(["dismissed_by_contractor"]);
export type ContractorRejectReason = z.infer<typeof ContractorRejectReasonSchema>;

/** Every reason code `rejectValue` accepts. */
export const RejectReasonSchema = z.union([FlagReasonSchema, ContractorRejectReasonSchema]);
export type RejectReason = z.infer<typeof RejectReasonSchema>;
