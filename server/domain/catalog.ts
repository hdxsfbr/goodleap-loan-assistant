// Mock loan product catalog. In production the loan product catalog service owns this data and
// Lending Ops owns its content; this file is the in-process stand-in that server/services serves
// through the catalog service interface. The catalog's content version in the audit log is the
// hash of this file (`catalog@<sha>`, computed in server/versions.ts), so every product, rule and
// sentence below is versioned without a hand-maintained constant.
//
// Parameter conventions: `term_months` is the product's own term; `apr_bps` is the APR charged on
// the balance (for the two promotional products it is the standard APR, which the calculator
// applies once the promotion ends or is lost); `promo_months` is the promotional period or null;
// `standard_apr_bps` is the rate after the promotion.

import { formatApr } from "@shared/format";
import type { Catalog, CatalogProduct } from "@shared/schemas";

/** The shape version the calculator checks. It changes when the shape of a product row changes. */
export const CATALOG_SCHEMA_VERSION = 1;

/**
 * The range every product is offered in: loan amounts from $5,000.00 to $100,000.00 and terms from
 * 5 to 25 years. The calculator refuses a request outside it.
 */
export const MIN_LOAN_AMOUNT_CENTS = 500_000;
export const MAX_LOAN_AMOUNT_CENTS = 10_000_000;
export const MIN_LOAN_TERM_MONTHS = 60;
export const MAX_LOAN_TERM_MONTHS = 300;

const FIXED_TERM_MONTHS = 120;
const FIXED_APR_BPS = 999;

const ZERO_INTRO_TERM_MONTHS = 120;
const ZERO_INTRO_PROMO_MONTHS = 18;
const ZERO_INTRO_STANDARD_APR_BPS = 1299;

const DEFERRED_TERM_MONTHS = 120;
const DEFERRED_PROMO_MONTHS = 12;
const DEFERRED_STANDARD_APR_BPS = 1799;

const FIXED_10Y: CatalogProduct = {
  id: "fixed_10y",
  name: "10-year fixed",
  mechanic: "fixed",
  term_months: FIXED_TERM_MONTHS,
  apr_bps: FIXED_APR_BPS,
  promo_months: null,
  standard_apr_bps: FIXED_APR_BPS,
  plain_sentence:
    "Option A is a fixed-rate loan: the same payment every month for ten years.",
  rules:
    `Fixed-rate loan at ${formatApr(FIXED_APR_BPS)} APR. The payment is the same every month for ` +
    `the whole term, and interest is charged on the balance still owed from the first month. The ` +
    `default term is ${FIXED_TERM_MONTHS} months; a different term can be requested for this ` +
    `product only. There is no promotional period.`,
};

const ZERO_INTRO_18M: CatalogProduct = {
  id: "zero_intro_18m",
  name: "0% for 18 months",
  mechanic: "zero_intro",
  term_months: ZERO_INTRO_TERM_MONTHS,
  apr_bps: ZERO_INTRO_STANDARD_APR_BPS,
  promo_months: ZERO_INTRO_PROMO_MONTHS,
  standard_apr_bps: ZERO_INTRO_STANDARD_APR_BPS,
  plain_sentence:
    "Option B charges no interest for the first 18 months; after that, interest applies to what is still owed.",
  rules:
    `Interest-free promotional period. For the first ${ZERO_INTRO_PROMO_MONTHS} months no ` +
    `interest is charged, and the monthly payment is the amount financed divided by the ` +
    `${ZERO_INTRO_TERM_MONTHS}-month term, so the balance falls slowly. After month ` +
    `${ZERO_INTRO_PROMO_MONTHS}, interest of ${formatApr(ZERO_INTRO_STANDARD_APR_BPS)} APR applies ` +
    `to the balance still owed, and that balance is repaid in level payments over the remaining ` +
    `${ZERO_INTRO_TERM_MONTHS - ZERO_INTRO_PROMO_MONTHS} months. The no-interest rate applies ` +
    `only during the promotional period. The APR in the disclosure is the annual percentage rate ` +
    `of the whole payment schedule, so it is lower than the standard rate. The term of this ` +
    `product is fixed at ${ZERO_INTRO_TERM_MONTHS} months and does not change with a requested ` +
    `term.`,
};

const DEFERRED_12M: CatalogProduct = {
  id: "deferred_12m",
  name: "12 months deferred interest",
  mechanic: "deferred_interest",
  term_months: DEFERRED_TERM_MONTHS,
  apr_bps: DEFERRED_STANDARD_APR_BPS,
  promo_months: DEFERRED_PROMO_MONTHS,
  standard_apr_bps: DEFERRED_STANDARD_APR_BPS,
  plain_sentence:
    "Option C charges no interest if the full balance is paid within 12 months; if it is not, interest from the start date is added.",
  rules:
    `Deferred-interest promotion. No interest is charged if the full balance is paid within ` +
    `${DEFERRED_PROMO_MONTHS} months; the payment that clears it is the amount financed divided ` +
    `by ${DEFERRED_PROMO_MONTHS}. If any balance remains after month ${DEFERRED_PROMO_MONTHS}, ` +
    `interest at ${formatApr(DEFERRED_STANDARD_APR_BPS)} APR is added from the start date, ` +
    `calculated monthly on the balance owed, and the new balance is repaid in level payments ` +
    `over the remaining ${DEFERRED_TERM_MONTHS - DEFERRED_PROMO_MONTHS} months. Whenever the ` +
    `no-interest outcome is described, what happens if the balance is not paid in full must be ` +
    `described with it. The APR in the disclosure is the annual percentage rate of the paid-in-full ` +
    `payment schedule; it is not the rate that applies if the balance is not paid in full. The term ` +
    `of this product is fixed at ${DEFERRED_TERM_MONTHS} months and does not change with a ` +
    `requested term.`,
};

/** The catalog, in option order: the first product is Option A, the second Option B, the third Option C. */
export const CATALOG: Catalog = {
  schema_version: CATALOG_SCHEMA_VERSION,
  products: [FIXED_10Y, ZERO_INTRO_18M, DEFERRED_12M],
};
