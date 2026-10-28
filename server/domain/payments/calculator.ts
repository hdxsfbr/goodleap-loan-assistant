// Deterministic money. Engineering owns this file; `calculator@<sha>` in the audit log is its
// content hash, so a change here is visible on every event written after it.
//
// Money is integer cents and APR is integer basis points. Every interest figure is the exact
// rational balance x bps / 120000 (monthly rate = bps / 10000 / 12) rounded half-even in integer
// arithmetic. The level payment P r / (1 - (1 + r)^-n) is the same kind of exact rational, one
// fraction of BigInts (see levelPaymentCents), rounded half-even to a whole number of cents, so
// an exact half-cent tie lands on the even cent. No float touches money. Nothing returned from
// this file is fractional.

import { formatApr, formatMoney } from "@shared/format";
import {
  CatalogSchema,
  type CalculatorResult,
  type Catalog,
  type CatalogProduct,
  type PaymentOption,
  type ScheduleRow,
} from "@shared/schemas";
import { AppError, CommandError } from "../../errors.js";
import { CATALOG_SCHEMA_VERSION } from "../catalog.js";

/** Option labels by catalog position: a product keeps its label whichever products are priced. */
const LABELS = [
  "Option A",
  "Option B",
  "Option C",
] as const satisfies readonly PaymentOption["label"][];

/** Upper bounds that keep every intermediate product an exactly representable integer. */
export const MAX_AMOUNT_CENTS = 10_000_000_000;
export const MAX_TERM_MONTHS = 600;

/** bps / 10000 / 12 as a fraction: interest = balance x bps / MONTHLY_RATE_DENOMINATOR. */
const MONTHLY_RATE_DENOMINATOR = 120_000;

// ---------------------------------------------------------------------------------------------
// Rounding and the two arithmetic primitives
// ---------------------------------------------------------------------------------------------

/** numerator / denominator for non-negative integers, rounded half-even, in exact integer arithmetic. */
export function divideRoundHalfEven(numerator: number, denominator: number): number {
  if (
    !Number.isSafeInteger(numerator) ||
    numerator < 0 ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  ) {
    throw new RangeError(
      `divideRoundHalfEven expects a non-negative numerator and a positive denominator, got ${numerator} / ${denominator}`,
    );
  }
  const remainder = numerator % denominator;
  const quotient = (numerator - remainder) / denominator;
  const twice = remainder * 2;
  if (!Number.isSafeInteger(twice)) {
    throw new RangeError(`divideRoundHalfEven overflow at ${numerator} / ${denominator}`);
  }
  if (twice < denominator) return quotient;
  if (twice > denominator) return quotient + 1;
  return quotient % 2 === 0 ? quotient : quotient + 1;
}

/** numerator / denominator for a non-negative BigInt numerator and a positive denominator, rounded half-even. */
function divideRoundHalfEvenBig(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice < denominator) return quotient;
  if (twice > denominator) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * One month's interest on a balance, in cents. The product balance x bps is formed in BigInt, so
 * the largest balance at the largest APR rounds exactly instead of overflowing a double.
 */
function monthlyInterest(balance_cents: number, apr_bps: number): number {
  const interest = divideRoundHalfEvenBig(
    BigInt(balance_cents) * BigInt(apr_bps),
    BigInt(MONTHLY_RATE_DENOMINATOR),
  );
  if (interest > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`monthlyInterest overflow at ${balance_cents} cents, ${apr_bps} bps`);
  }
  return Number(interest);
}

/**
 * The level monthly payment that repays `principal_cents` over `months` at `apr_bps`, in cents.
 *
 * With r = bps / 120000 the payment P r / (1 - (1 + r)^-n) is the single fraction
 *
 *   P x bps x (120000 + bps)^n / (120000 x ((120000 + bps)^n - 120000^n))
 *
 * evaluated in BigInt and rounded half-even once, so a payment that is exactly half a cent
 * rounds to the even cent and agrees with the schedule built from it.
 */
export function levelPaymentCents(principal_cents: number, apr_bps: number, months: number): number {
  if (!Number.isSafeInteger(principal_cents) || principal_cents < 0) {
    throw new RangeError(`levelPaymentCents expects non-negative integer cents, got ${principal_cents}`);
  }
  if (!Number.isSafeInteger(apr_bps) || apr_bps < 0) {
    throw new RangeError(`levelPaymentCents expects non-negative integer basis points, got ${apr_bps}`);
  }
  if (!Number.isSafeInteger(months) || months < 1) {
    throw new RangeError(`levelPaymentCents expects a positive whole number of months, got ${months}`);
  }
  if (principal_cents === 0) return 0;
  if (apr_bps === 0) return divideRoundHalfEven(principal_cents, months);
  const base = BigInt(MONTHLY_RATE_DENOMINATOR);
  const grown = base + BigInt(apr_bps);
  const growth = grown ** BigInt(months);
  const numerator = BigInt(principal_cents) * BigInt(apr_bps) * growth;
  const denominator = base * (growth - base ** BigInt(months));
  const payment = divideRoundHalfEvenBig(numerator, denominator);
  if (payment > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`levelPaymentCents overflow at ${principal_cents} cents, ${apr_bps} bps, ${months} months`);
  }
  return Number(payment);
}

// ---------------------------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------------------------

function sum(rows: readonly ScheduleRow[], key: "payment_cents" | "interest_cents" | "principal_cents"): number {
  return rows.reduce((total, row) => total + row[key], 0);
}

function lastRow(rows: readonly ScheduleRow[]): ScheduleRow {
  const row = rows[rows.length - 1];
  if (!row) throw new AppError("internal", "A payment schedule has no rows.");
  return row;
}

/**
 * Level-payment rows: each month charges interest on the balance and takes the payment's
 * remainder as principal; the last month pays the remaining balance plus its interest.
 */
function amortizationRows(args: {
  balance_cents: number;
  apr_bps: number;
  months: number;
  payment_cents: number;
  first_month: number;
}): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let balance = args.balance_cents;
  for (let i = 0; i < args.months; i += 1) {
    const interest = monthlyInterest(balance, args.apr_bps);
    const isLast = i === args.months - 1;
    const principal = isLast ? balance : Math.min(Math.max(args.payment_cents - interest, 0), balance);
    balance -= principal;
    rows.push({
      month: args.first_month + i,
      payment_cents: interest + principal,
      interest_cents: interest,
      principal_cents: principal,
      balance_cents: balance,
    });
  }
  return rows;
}

/**
 * Principal-only rows with no interest. With `clear_balance` the last month pays whatever is
 * left, so a payment that does not divide the amount evenly leaves no residual.
 */
function interestFreeRows(args: {
  balance_cents: number;
  payment_cents: number;
  months: number;
  first_month: number;
  clear_balance: boolean;
}): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let balance = args.balance_cents;
  for (let i = 0; i < args.months; i += 1) {
    const isLast = i === args.months - 1;
    const principal = args.clear_balance && isLast ? balance : Math.min(args.payment_cents, balance);
    balance -= principal;
    rows.push({
      month: args.first_month + i,
      payment_cents: principal,
      interest_cents: 0,
      principal_cents: principal,
      balance_cents: balance,
    });
  }
  return rows;
}

/** A schedule that does not repay exactly the amount financed is a bug, never an output. */
function assertRepaid(rows: readonly ScheduleRow[], amount_cents: number, productId: string): void {
  if (lastRow(rows).balance_cents !== 0 || sum(rows, "principal_cents") !== amount_cents) {
    throw new AppError("internal", `The ${productId} schedule does not repay the amount financed.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Catalog and input validation
// ---------------------------------------------------------------------------------------------

function schemaMismatch(cause?: unknown): AppError {
  return new AppError("catalog.schema_mismatch", undefined, cause === undefined ? undefined : { cause });
}

/** The largest APR a catalog row may carry: 1000.00%, which keeps every interest product exactly representable. */
export const MAX_APR_BPS = 100_000;

function isWithin(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validateCatalog(catalog: Catalog): void {
  if (catalog.schema_version !== CATALOG_SCHEMA_VERSION) throw schemaMismatch();
  const parsed = CatalogSchema.safeParse(catalog);
  if (!parsed.success) throw schemaMismatch(parsed.error);
  if (catalog.products.length > LABELS.length) throw schemaMismatch();
  const seen = new Set<string>();
  for (const product of catalog.products) {
    if (seen.has(product.id)) throw schemaMismatch();
    seen.add(product.id);
    // Bounds are checked before any pricing: a term of a billion months would build a billion-row
    // schedule, and an APR in the millions would overflow the exact integer arithmetic.
    if (!isWithin(product.term_months, 1, MAX_TERM_MONTHS)) throw schemaMismatch();
    if (!isWithin(product.apr_bps, 0, MAX_APR_BPS)) throw schemaMismatch();
    if (!isWithin(product.standard_apr_bps, 0, MAX_APR_BPS)) throw schemaMismatch();
    if (product.promo_months !== null && !isWithin(product.promo_months, 1, product.term_months - 1)) {
      throw schemaMismatch();
    }
    // apr_bps is the APR charged on the balance, which for a promotional product is its standard
    // APR; a catalog that lists 0 here would put 0.00% in the APR cell of the disclosure.
    if (product.apr_bps !== product.standard_apr_bps) throw schemaMismatch();
    if (product.mechanic !== "fixed" && product.promo_months === null) throw schemaMismatch();
  }
}

function requirePromoMonths(product: CatalogProduct): number {
  if (product.promo_months === null) throw schemaMismatch();
  return product.promo_months;
}

function validateAmount(amount_cents: number): void {
  if (!Number.isSafeInteger(amount_cents) || amount_cents < 1 || amount_cents > MAX_AMOUNT_CENTS) {
    throw new CommandError(
      `Enter a loan amount between ${formatMoney(1)} and ${formatMoney(MAX_AMOUNT_CENTS)}.`,
      { status: 400 },
    );
  }
}

function validateTerm(term_months: number | null): void {
  if (term_months === null) return;
  if (!Number.isSafeInteger(term_months) || term_months < 1 || term_months > MAX_TERM_MONTHS) {
    throw new CommandError(`Choose a term between 1 and ${MAX_TERM_MONTHS} months.`, { status: 400 });
  }
}

function selectProducts(
  catalog: Catalog,
  productIds: readonly string[] | undefined,
): { product: CatalogProduct; index: number }[] {
  const all = catalog.products.map((product, index) => ({ product, index }));
  if (productIds === undefined) return all;
  if (productIds.length === 0) throw new CommandError("Choose at least one product.", { status: 400 });
  for (const id of productIds) {
    if (!all.some(({ product }) => product.id === id)) {
      throw new CommandError("That product is not in the catalog.", { status: 400 });
    }
  }
  return all.filter(({ product }) => productIds.includes(product.id));
}

// ---------------------------------------------------------------------------------------------
// Mechanics
// ---------------------------------------------------------------------------------------------

type Label = PaymentOption["label"];

function priceFixed(label: Label, product: CatalogProduct, amount: number, term: number): PaymentOption {
  const payment = levelPaymentCents(amount, product.apr_bps, term);
  const schedule = amortizationRows({
    balance_cents: amount,
    apr_bps: product.apr_bps,
    months: term,
    payment_cents: payment,
    first_month: 1,
  });
  assertRepaid(schedule, amount, product.id);
  return {
    label,
    product_id: product.id,
    product_name: product.name,
    mechanic: product.mechanic,
    term_months: term,
    apr_bps: product.apr_bps,
    payment_cents: payment,
    finance_charge_cents: sum(schedule, "interest_cents"),
    amount_financed_cents: amount,
    total_of_payments_cents: sum(schedule, "payment_cents"),
    schedule,
  };
}

function priceZeroIntro(label: Label, product: CatalogProduct, amount: number): PaymentOption {
  const promo = requirePromoMonths(product);
  const promoPayment = divideRoundHalfEven(amount, product.term_months);
  const promoRows = interestFreeRows({
    balance_cents: amount,
    payment_cents: promoPayment,
    months: promo,
    first_month: 1,
    clear_balance: false,
  });
  const balanceAfterPromo = lastRow(promoRows).balance_cents;
  const remaining = product.term_months - promo;
  const payment = levelPaymentCents(balanceAfterPromo, product.standard_apr_bps, remaining);
  const standardRows = amortizationRows({
    balance_cents: balanceAfterPromo,
    apr_bps: product.standard_apr_bps,
    months: remaining,
    payment_cents: payment,
    first_month: promo + 1,
  });
  const schedule = [...promoRows, ...standardRows];
  assertRepaid(schedule, amount, product.id);
  return {
    label,
    product_id: product.id,
    product_name: product.name,
    mechanic: product.mechanic,
    term_months: product.term_months,
    apr_bps: product.apr_bps,
    promo_apr_bps: 0,
    payment_cents: payment,
    promo_payment_cents: Math.min(promoPayment, amount),
    promo_months: promo,
    finance_charge_cents: sum(schedule, "interest_cents"),
    amount_financed_cents: amount,
    total_of_payments_cents: sum(schedule, "payment_cents"),
    schedule,
  };
}

/** What happens to a deferred-interest balance that is not paid in full by the end of the promotion. */
export interface DeferredConsequence {
  /** The principal-only payment assumed during the promotion: amount / term, rounded. */
  minimum_payment_cents: number;
  /** Interest accrued monthly at the standard APR on the running balance, added at the promotion's end. */
  interest_added_cents: number;
  /** The principal still owed plus the interest added. */
  balance_at_promo_end_cents: number;
  /** The level payment that follows, over the remaining months. */
  payment_cents: number;
  /** The last of those payments: the remaining balance plus its interest. */
  final_payment_cents: number;
  /** Interest added plus the interest charged after the promotion. */
  finance_charge_cents: number;
  /** Every payment in this scenario, promotion and after. */
  total_cents: number;
}

export function deferredConsequence(amount_cents: number, product: CatalogProduct): DeferredConsequence {
  const promo = requirePromoMonths(product);
  const minimum = divideRoundHalfEven(amount_cents, product.term_months);
  let balance = amount_cents;
  let accrued = 0;
  let paidDuringPromo = 0;
  for (let month = 1; month <= promo; month += 1) {
    accrued += monthlyInterest(balance, product.standard_apr_bps);
    const payment = Math.min(minimum, balance);
    balance -= payment;
    paidDuringPromo += payment;
  }
  const balanceAtPromoEnd = balance + accrued;
  const remaining = product.term_months - promo;
  const payment = levelPaymentCents(balanceAtPromoEnd, product.standard_apr_bps, remaining);
  const rows = amortizationRows({
    balance_cents: balanceAtPromoEnd,
    apr_bps: product.standard_apr_bps,
    months: remaining,
    payment_cents: payment,
    first_month: promo + 1,
  });
  return {
    minimum_payment_cents: minimum,
    interest_added_cents: accrued,
    balance_at_promo_end_cents: balanceAtPromoEnd,
    payment_cents: payment,
    final_payment_cents: lastRow(rows).payment_cents,
    finance_charge_cents: accrued + sum(rows, "interest_cents"),
    total_cents: paidDuringPromo + sum(rows, "payment_cents"),
  };
}

function priceDeferred(label: Label, product: CatalogProduct, amount: number): PaymentOption {
  const promo = requirePromoMonths(product);
  const payment = divideRoundHalfEven(amount, promo);
  // The option's own figures are the paid-in-full plan, so its schedule is that plan.
  const schedule = interestFreeRows({
    balance_cents: amount,
    payment_cents: payment,
    months: promo,
    first_month: 1,
    clear_balance: true,
  });
  assertRepaid(schedule, amount, product.id);
  const consequence = deferredConsequence(amount, product);
  return {
    label,
    product_id: product.id,
    product_name: product.name,
    mechanic: product.mechanic,
    term_months: product.term_months,
    apr_bps: product.apr_bps,
    promo_apr_bps: 0,
    payment_cents: payment,
    promo_months: promo,
    finance_charge_cents: sum(schedule, "interest_cents"),
    amount_financed_cents: amount,
    total_of_payments_cents: sum(schedule, "payment_cents"),
    schedule,
    consequence: {
      interest_added_cents: consequence.interest_added_cents,
      payment_cents: consequence.payment_cents,
      total_cents: consequence.total_cents,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export interface CalculateInput {
  amount_cents: number;
  /** The term asked for, which applies to `fixed` only; null means each product's catalog term. */
  term_months: number | null;
  /** The catalog snapshot the options are priced from. Its `schema_version` is checked. */
  products: Catalog;
  /** Price only these products. Each keeps its catalog position, so its label does not change. */
  product_ids?: readonly string[];
}

/** Prices each requested product: Option A, B and C by catalog position. */
export function calculate(input: CalculateInput): CalculatorResult {
  validateCatalog(input.products);
  validateAmount(input.amount_cents);
  validateTerm(input.term_months);
  const options = selectProducts(input.products, input.product_ids).map(({ product, index }) => {
    const label = LABELS[index];
    if (label === undefined) throw schemaMismatch();
    switch (product.mechanic) {
      case "fixed":
        return priceFixed(label, product, input.amount_cents, input.term_months ?? product.term_months);
      case "zero_intro":
        return priceZeroIntro(label, product, input.amount_cents);
      case "deferred_interest":
        return priceDeferred(label, product, input.amount_cents);
    }
  });
  return { amount_cents: input.amount_cents, term_months: input.term_months, options };
}

/** The months that follow the promotional period: the term less the promo months (the whole term when there is none). */
export function monthsAfterPromo(option: PaymentOption): number {
  return option.term_months - (option.promo_months ?? 0);
}

/**
 * A term in years, in integer arithmetic: whole years as "10 years", otherwise one decimal where
 * that is exact ("7.5 years" for 90 months) and otherwise two decimals, rounded half-even
 * ("8.33 years" for 100 months).
 */
function termInYears(term_months: number): string {
  if (term_months % 12 === 0) return `${term_months / 12} years`;
  const decimals = (term_months * 10) % 12 === 0 ? 1 : 2;
  const scale = decimals === 1 ? 10 : 100;
  const scaled = divideRoundHalfEven(term_months * scale, 12);
  const whole = (scaled - (scaled % scale)) / scale;
  return `${whole}.${String(scaled % scale).padStart(decimals, "0")} years`;
}

/**
 * The figures the number-match check allows prose about this option to contain, each through the
 * shared formatters: payment, promo payment, consequence payment, APR, promo rate, finance
 * charge, amount financed, total of payments, consequence total, interest added, the term in
 * months and in years, and the promotional and post-promotional month counts that the
 * disclosure block itself prints.
 */
export function calculatorValues(option: PaymentOption): string[] {
  const values: string[] = [formatMoney(option.payment_cents)];
  if (option.promo_payment_cents !== undefined) values.push(formatMoney(option.promo_payment_cents));
  if (option.consequence) values.push(formatMoney(option.consequence.payment_cents));
  values.push(formatApr(option.apr_bps));
  if (option.promo_apr_bps !== undefined) values.push(formatApr(option.promo_apr_bps));
  values.push(
    formatMoney(option.finance_charge_cents),
    formatMoney(option.amount_financed_cents),
    formatMoney(option.total_of_payments_cents),
  );
  if (option.consequence) {
    values.push(formatMoney(option.consequence.total_cents), formatMoney(option.consequence.interest_added_cents));
  }
  values.push(`${option.term_months} months`, termInYears(option.term_months));
  if (option.promo_months !== undefined) {
    values.push(`${option.promo_months} months`, `${monthsAfterPromo(option)} months`);
  }
  return [...new Set(values)];
}

/** The allowed figures for a whole calculation: every option's values, once each. */
export function calculatorValuesForResult(result: CalculatorResult): string[] {
  return [...new Set(result.options.flatMap(calculatorValues))];
}
