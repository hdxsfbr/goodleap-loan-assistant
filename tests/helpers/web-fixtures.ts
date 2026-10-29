import type {
  ApplicationView,
  DisclosureBlock,
  HomeownerViewProps,
  OptionDisplay,
  PaymentOption,
  ProposedValue,
  VersionsBlock,
} from "@shared/schemas";
import type { OptionsLine } from "../../web/src/types";

// Fixtures the web client tests share: three payment options with their disclosure block, the
// `options` stream line and homeowner props built from them, and small builders for proposals and
// application views.

export const VERSIONS: VersionsBlock = {
  copilot_prompt: "copilot@aaaaaaaa",
  judge_prompt: "judge@bbbbbbbb",
  extraction_prompt: "extraction@cccccccc",
  denylist: "denylist@dddddddd",
  template: "template@eeeeeeee",
  catalog: "catalog@ffffffff",
  calculator: "calculator@11111111",
  application_schema: "application_schema@22222222",
  schemas: "schemas@33333333",
  fallback_texts: "fallback_texts@44444444",
  git_sha: "0123456789abcdef",
  copilot_model: "claude-sonnet-5-5",
  extraction_model: "claude-opus-5-5",
  judge_model: "claude-haiku-5-5",
};

export function option(
  overrides: Partial<PaymentOption> & Pick<PaymentOption, "label" | "product_id" | "mechanic">,
): PaymentOption {
  return {
    product_name: "Product",
    term_months: 120,
    apr_bps: 999,
    payment_cents: 38750,
    finance_charge_cents: 1650000,
    amount_financed_cents: 3000000,
    total_of_payments_cents: 4650000,
    schedule: [],
    ...overrides,
  };
}

export const FIXED = option({ label: "Option A", product_id: "fixed_10y", mechanic: "fixed", product_name: "10-year fixed" });
export const ZERO_INTRO = option({
  label: "Option B",
  product_id: "zero_intro_18m",
  mechanic: "zero_intro",
  product_name: "0% for 18 months",
  apr_bps: 1299,
  promo_apr_bps: 0,
  promo_months: 18,
  promo_payment_cents: 25000,
  payment_cents: 36400,
});
export const DEFERRED = option({
  label: "Option C",
  product_id: "deferred_12m",
  mechanic: "deferred_interest",
  product_name: "12 months deferred interest",
  apr_bps: 1799,
  promo_months: 12,
  payment_cents: 250000,
});

/** The TILA entry of one option, as the template composes it. */
export function disclosureEntry(source: PaymentOption, apr: string): DisclosureBlock["options"][number] {
  return {
    label: source.label,
    product_id: source.product_id,
    apr,
    finance_charge: "$16,500.00",
    amount_financed: "$30,000.00",
    total_of_payments: "$46,500.00",
    schedule_line: "120 monthly payments of $387.50",
    consequence_line: source.mechanic === "deferred_interest" ? "If not paid in full in 12 months, interest is added." : null,
  };
}

/** One entry per option: three products, three disclosure entries. */
export const BLOCK: DisclosureBlock = {
  options: [disclosureEntry(FIXED, "9.99%"), disclosureEntry(ZERO_INTRO, "12.99%"), disclosureEntry(DEFERRED, "17.99%")],
  estimate_statement: "This is a payment estimate, not an offer of credit; final terms depend on credit approval.",
  respa_line: "If this loan is secured by your home, a settlement cost statement will be provided.",
};

/** The same block with the deferred option's entry missing. */
export const SHORT_BLOCK: DisclosureBlock = { ...BLOCK, options: BLOCK.options.slice(0, 2) };

export const FOOTER = "Estimates only. Not an offer of credit; subject to credit approval.";

/** The server's display strings for the three options. */
export const OPTIONS_DISPLAY: OptionDisplay[] = [
  { label: "Option A", product_id: "fixed_10y", payment_text: "SERVER-PAY-A", term_text: "SERVER-TERM-A", apr_text: "SERVER-APR-A" },
  { label: "Option B", product_id: "zero_intro_18m", payment_text: "SERVER-PAY-B", term_text: "SERVER-TERM-B", apr_text: "SERVER-APR-B" },
  { label: "Option C", product_id: "deferred_12m", payment_text: "SERVER-PAY-C", term_text: "SERVER-TERM-C", apr_text: "SERVER-APR-C" },
];

export const OPTIONS_LINE: OptionsLine = {
  type: "options",
  options_id: "opt_1",
  calculator_result: { amount_cents: 3000000, term_months: null, options: [FIXED, ZERO_INTRO, DEFERRED] },
  inputs_echo: "$30,000 over 120 months",
  inputs_source: { amount: "form", term: "catalog" },
  argument_label: null,
  options_display: OPTIONS_DISPLAY,
  disclosure_block: BLOCK,
  footer: FOOTER,
};

export const MECHANIC_SENTENCES: HomeownerViewProps["mechanic_sentences"] = {
  fixed_10y: "A fixed rate and the same payment every month.",
  zero_intro_18m: "No interest for 18 months, then the standard rate.",
  deferred_12m: "Interest is added if the balance is not paid in full in 12 months.",
};

export const HOMEOWNER_PROPS: HomeownerViewProps = {
  options: OPTIONS_LINE.calculator_result,
  options_display: OPTIONS_DISPLAY,
  disclosure_block: BLOCK,
  explanation: "Option A costs less per month and more over the life of the loan.",
  mechanic_sentences: MECHANIC_SENTENCES,
  what_happens_next: "Your contractor will submit the application for review.",
  template_version: "template@eeeeeeee",
};

/** The same object as an older server would have sent it, without `options_display`. */
export function withoutDisplay<T extends { options_display: unknown }>(value: T): Omit<T, "options_display"> {
  const { options_display: _omitted, ...rest } = value;
  return rest;
}

export function proposal(id: string, fieldKey: string, value: string | number, messageId: string, quote = "quoted words"): ProposedValue {
  return {
    id,
    application_id: "app_demo_001",
    field_key: fieldKey,
    value,
    source: { kind: "message", ref: { message_id: messageId, quote } },
    state: "proposed",
    versions: VERSIONS,
    audit_event_id: `evt_${id}`,
    actor_id: "copilot",
  };
}

export function applicationView(fields: ApplicationView["fields"], status: ApplicationView["status"] = "draft"): ApplicationView {
  return {
    id: "app_demo_001",
    contractor_id: "ctr_demo_001",
    status,
    fields,
    verified: { verified_annual_income: null, verification_source: null },
    document_ids: [],
    documents: [],
    banner: null,
  };
}

export function proposedField(
  value: string | number,
  proposalId: string,
  source: ApplicationView["fields"][string]["source_ref"] = {
    kind: "message",
    ref: { message_id: "m_1", quote: "quoted words" },
  },
  previous: ApplicationView["fields"][string]["previous"] = null,
): ApplicationView["fields"][string] {
  return { value, state: "proposed", source_ref: source, proposal_id: proposalId, previous };
}

export function typedField(value: string | number): ApplicationView["fields"][string] {
  return { value, state: "typed", source_ref: null, proposal_id: null, previous: null };
}
