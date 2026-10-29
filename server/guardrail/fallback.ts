// COMPLIANCE-OWNED. Every fixed text of the assistant lives here or in the disclosure template
// (server/domain/disclosures/template.ts), and nowhere else: the prompts (through
// server/copilot/context.ts), the tests, the web (through API responses) and the submission
// document all quote these constants, never a copy. `fallback_texts@<sha>` in the audit log is
// this file's content hash, so a reworded line is visible on every event written after it.
// Engineering changes only the code that places the text.

import type { DiscrepancyReason } from "@shared/reason-codes";
import type { PaymentOption } from "@shared/schemas";
import type { ProductId } from "@shared/catalog-ids";
import { CATALOG } from "../domain/catalog.js";
import { fixedSentenceForTerm } from "../domain/disclosures/template.js";

// Fixed texts owned by other files, re-exported so this file is the one place that names them all.
export { BANNER_TEXT } from "../domain/banner.js";
export {
  CHAT_FOOTER,
  ESTIMATE_STATEMENT,
  RESPA_LINE,
  SCHEDULE_LINE,
  WHAT_HAPPENS_NEXT,
} from "../domain/disclosures/template.js";

/** The answer to any question about approval, likelihood or qualification. */
export const OUT_OF_SCOPE_REPLY =
  "Approval decisions are made by GoodLeap's credit team after the application is submitted, so I can't say whether this application will be approved.";

/** The two things the assistant offers after `OUT_OF_SCOPE_REPLY`, each verbatim. */
export const OUT_OF_SCOPE_ACTIONS = [
  "Show payment options for this project",
  "List what the application still needs",
] as const;

/** Shown in place of model prose when the wording check blocks a reply twice (or cannot run). */
export const FALLBACK_REPLY =
  "I can't phrase that in a way that meets lending rules. The payment options above are accurate and include the required disclosures. I can show them to the homeowner, explain how a promotional period works, or list what the application still needs.";

/** The visible marker beside `FALLBACK_REPLY`; it links to the audit view. */
export const FALLBACK_MARKER = "Wording adjusted to comply with lending rules. View in audit";

/**
 * One sentence per product, used when a homeowner view has no judged explanation: the sentence the
 * catalog carries for the product (`plain_sentence`), so the words live in the catalog row only.
 */
export const CANNED_SENTENCE: Readonly<Record<ProductId, string>> = Object.fromEntries(
  CATALOG.products.map((product) => [product.id, product.plain_sentence]),
) as Record<ProductId, string>;

/**
 * The canned sentence for one priced option: `CANNED_SENTENCE`, except for a fixed product priced
 * at a term other than the catalog's, which uses the template's term-aware form of the same
 * sentence (`fixedSentenceForTerm`) so the homeowner never reads "ten years" beside a 15-year payment.
 */
export function cannedSentenceFor(option: PaymentOption): string {
  const catalogTerm = CATALOG.products.find((product) => product.id === option.product_id)?.term_months;
  if (option.mechanic === "fixed" && option.term_months !== catalogTerm) {
    return fixedSentenceForTerm(option.term_months);
  }
  return CANNED_SENTENCE[option.product_id];
}

/** The explanation a homeowner view carries when the turn has no judged one: the canned sentences of the options shown, in order. */
export function cannedExplanation(options: readonly PaymentOption[]): string {
  return options.map(cannedSentenceFor).join(" ");
}

/** The reviewer's clarification questions by discrepancy reason; `{stated}` and `{extracted}` are filled with formatted money. */
export const CLARIFICATION_TEMPLATE: Readonly<Record<DiscrepancyReason, string>> = {
  income_outside_tolerance:
    "The application lists an annual income of {stated}. The pay stub we received works out to {extracted} a year. Could you ask the homeowner whether the application figure includes other income, and let us know?",
  requested_amount_over_estimate:
    "The application requests {stated}. The project estimate we received totals {extracted}. Could you confirm the amount the homeowner wants to finance?",
};

export const NOT_LOCATED_CAPTION =
  "The value was extracted but its position on the page could not be matched. Find it on the page to confirm, correct it, or flag it.";

export const LOCATED_ACK = "I located this on the page myself";

/** The caption on the disabled "Show payment options" button, and the reason the route refuses. */
export const NO_MODEL_CAPTION = "Confirm a requested loan amount first";

/** The stepwise status line of a copilot turn, in the order the steps start. */
export const STATUS_STEPS = [
  "Finding matching products...",
  "Calculating payments...",
  "Writing the explanation...",
  "Checking wording...",
] as const;

/** Words a reply to an approval question must not contain (checked by tests/out-of-scope-reply.test.ts). */
export const LIKELIHOOD_WORDS = [
  "likely",
  "unlikely",
  "probably",
  "chance",
  "odds",
  "should be fine",
  "looks good",
  "good shot",
  "easily",
] as const;
