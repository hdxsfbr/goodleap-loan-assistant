// COMPLIANCE-OWNED. This file holds the fixed disclosure text of the homeowner view and the chat
// footer. Compliance reviews every change to the wording below; engineering changes only the
// code that places it. `template@<sha>` in the audit log is this file's content hash, so a
// reworded line is visible on every event and homeowner view written after it.
//
// The template does no arithmetic. It receives the calculator's integer cents, basis points and
// month counts, prints them through shared/format.ts (the only money and APR formatters) and
// fills the fixed sentences. The month count that follows a promotional period comes from the
// calculator (monthsAfterPromo), not from a subtraction here, and the APR cell is the calculator's
// APR of the payment schedule shown (schedule_apr_bps), not the product's standard rate.

import { formatApr, formatMoney } from "@shared/format";
import type { DisclosureBlock, OptionDisplay, PaymentOption } from "@shared/schemas";
import { monthsAfterPromo } from "../payments/calculator.js";

export const CHAT_FOOTER = "Estimates only. Not an offer of credit; subject to credit approval.";

export const ESTIMATE_STATEMENT =
  "This is a payment estimate, not an offer of credit; final terms depend on credit approval.";

export const RESPA_LINE =
  "If this loan is secured by your home, a settlement cost statement will be provided.";

export const WHAT_HAPPENS_NEXT =
  "Nothing is decided today. The application goes to GoodLeap for review, and the final terms come in writing before anything is signed.";

/** `single` for a level schedule; `promotional` for a promotional payment followed by a standard one. */
export const SCHEDULE_LINE = {
  single: "{count} monthly payments of {payment}",
  promotional:
    "{promo_count} monthly payments of {promo_payment}, then {count} monthly payments of {payment}",
} as const;

/**
 * The options table's cells, worded once here so no client formats a number: the payment per
 * mechanic ("{promo_payment} a month for the first {promo} months, then {payment} a month" for a
 * zero-intro option), the term in months and the APR through `formatApr`.
 */
export const OPTION_DISPLAY = {
  payment: {
    single: "{payment} a month",
    deferred: "{payment} a month for {promo} months",
    promotional: "{promo_payment} a month for the first {promo} months, then {payment} a month",
  },
  term: "{count} months",
  term_one: "1 month",
} as const;

/** Printed for a deferred-interest option: what happens if the balance is not paid in full. */
export const CONSEQUENCE_LINE =
  "If the balance is not paid in full by month {promo}, {interest_added} of interest is added and the payment becomes {payment} for the remaining {months} months.";

/**
 * The catalog's fixed-product sentence with its duration as a placeholder: word for word the
 * `fixed_10y` plain sentence ("... for ten years.") apart from `{term}`. Shown in place of the
 * catalog sentence when the fixed option runs a term other than the catalog's.
 */
export const FIXED_SENTENCE_FOR_TERM =
  "Option A is a fixed-rate loan: the same payment every month for {term}.";

function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The disclosure template has no value for {${name}}.`);
    return value;
  });
}

/** "5 years" for a whole number of years, "90 months" otherwise; "1 year" and "1 month" in the singular. */
function termPhrase(term_months: number): string {
  if (term_months % 12 === 0) {
    const years = term_months / 12;
    return years === 1 ? "1 year" : `${years} years`;
  }
  return term_months === 1 ? "1 month" : `${term_months} months`;
}

/** The fixed-product sentence for a term in months: `FIXED_SENTENCE_FOR_TERM` with the duration filled in. */
export function fixedSentenceForTerm(term_months: number): string {
  if (!Number.isSafeInteger(term_months) || term_months < 1) {
    throw new RangeError(`fixedSentenceForTerm expects a positive whole number of months, got ${term_months}`);
  }
  return fill(FIXED_SENTENCE_FOR_TERM, { term: termPhrase(term_months) });
}

function required<T>(value: T | undefined, option: PaymentOption, field: string): T {
  if (value === undefined) {
    throw new Error(`${option.product_id} cannot be disclosed without ${field}.`);
  }
  return value;
}

function scheduleLine(option: PaymentOption): string {
  switch (option.mechanic) {
    case "fixed":
      return fill(SCHEDULE_LINE.single, {
        count: String(option.term_months),
        payment: formatMoney(option.payment_cents),
      });
    case "zero_intro":
      return fill(SCHEDULE_LINE.promotional, {
        promo_count: String(required(option.promo_months, option, "promo_months")),
        promo_payment: formatMoney(required(option.promo_payment_cents, option, "promo_payment_cents")),
        count: String(monthsAfterPromo(option)),
        payment: formatMoney(option.payment_cents),
      });
    case "deferred_interest":
      // The option's payment is the plan that pays the balance in full within the promotion;
      // what follows if it is not paid in full is the consequence line.
      return fill(SCHEDULE_LINE.single, {
        count: String(required(option.promo_months, option, "promo_months")),
        payment: formatMoney(option.payment_cents),
      });
  }
}

function consequenceLine(option: PaymentOption): string | null {
  if (option.mechanic !== "deferred_interest") return null;
  const consequence = required(option.consequence, option, "consequence");
  return fill(CONSEQUENCE_LINE, {
    promo: String(required(option.promo_months, option, "promo_months")),
    interest_added: formatMoney(consequence.interest_added_cents),
    payment: formatMoney(consequence.payment_cents),
    months: String(monthsAfterPromo(option)),
  });
}

function paymentText(option: PaymentOption): string {
  switch (option.mechanic) {
    case "fixed":
      return fill(OPTION_DISPLAY.payment.single, { payment: formatMoney(option.payment_cents) });
    case "zero_intro":
      return fill(OPTION_DISPLAY.payment.promotional, {
        promo_payment: formatMoney(required(option.promo_payment_cents, option, "promo_payment_cents")),
        promo: String(required(option.promo_months, option, "promo_months")),
        payment: formatMoney(option.payment_cents),
      });
    case "deferred_interest":
      return fill(OPTION_DISPLAY.payment.deferred, {
        payment: formatMoney(option.payment_cents),
        promo: String(required(option.promo_months, option, "promo_months")),
      });
  }
}

/** The APR of the schedule the option discloses, which is what the APR cell prints. */
function scheduleApr(option: PaymentOption): string {
  return formatApr(required(option.schedule_apr_bps, option, "schedule_apr_bps"));
}

/**
 * The options table cells for a set of options, one entry per option in the calculator's order:
 * the payment wording, the term and the schedule's APR as the person reads them. Every figure
 * printed is one of the option's `calculatorValues`.
 */
export function renderOptionsDisplay(options: readonly PaymentOption[]): OptionDisplay[] {
  return options.map((option) => ({
    label: option.label,
    product_id: option.product_id,
    payment_text: paymentText(option),
    term_text:
      option.term_months === 1
        ? OPTION_DISPLAY.term_one
        : fill(OPTION_DISPLAY.term, { count: String(option.term_months) }),
    apr_text: scheduleApr(option),
  }));
}

/**
 * The disclosure block for a set of options: per option the four TILA cells (the APR of the
 * schedule shown, finance charge, amount financed, total of payments) and the schedule line, the
 * consequence line for a deferred-interest option, then the estimate statement and the RESPA line.
 */
export function renderDisclosureBlock(options: readonly PaymentOption[]): DisclosureBlock {
  return {
    options: options.map((option) => ({
      label: option.label,
      product_id: option.product_id,
      apr: scheduleApr(option),
      finance_charge: formatMoney(option.finance_charge_cents),
      amount_financed: formatMoney(option.amount_financed_cents),
      total_of_payments: formatMoney(option.total_of_payments_cents),
      schedule_line: scheduleLine(option),
      consequence_line: consequenceLine(option),
    })),
    estimate_statement: ESTIMATE_STATEMENT,
    respa_line: RESPA_LINE,
  };
}

/** The footer under a contractor-chat reply that carries payment figures. */
export function renderChatFooter(): string {
  return CHAT_FOOTER;
}
