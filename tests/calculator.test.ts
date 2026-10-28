import { describe, expect, it } from "vitest";
import { formatMoney } from "@shared/format";
import { normalizeFigure } from "@shared/normalize";
import { CatalogSchema, type Catalog, type CatalogProduct, type PaymentOption } from "@shared/schemas";
import { CATALOG, CATALOG_SCHEMA_VERSION } from "../server/domain/catalog.js";
import {
  MAX_AMOUNT_CENTS,
  MAX_TERM_MONTHS,
  calculate,
  calculatorValues,
  calculatorValuesForResult,
  deferredConsequence,
  divideRoundHalfEven,
  levelPaymentCents,
  monthsAfterPromo,
} from "../server/domain/payments/calculator.js";
import { AppError, CommandError } from "../server/errors.js";
import { services } from "../server/services/index.js";

// Item 74: the golden cases, exact to the cent, against the catalog of item 30. The expected
// figures are written as the dollar strings of the design's table and converted to cents here.

function usd(text: string): number {
  const match = /^\$(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(text);
  if (!match) throw new Error(`not a dollar amount: ${text}`);
  return Number((match[1] ?? "").replace(/,/g, "")) * 100 + Number(match[2]);
}

function product(id: string): CatalogProduct {
  const found = CATALOG.products.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no catalog product ${id}`);
  return found;
}

function price(productId: string, amount: string, term: number | null = null): PaymentOption {
  const result = calculate({
    amount_cents: usd(amount),
    term_months: term,
    products: CATALOG,
    product_ids: [productId],
  });
  const option = result.options[0];
  if (result.options.length !== 1 || !option) throw new Error("expected exactly one option");
  return option;
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

/** What every schedule must satisfy, whatever the product, amount or term. */
function expectConsistent(option: PaymentOption): void {
  const { schedule } = option;
  let balance = option.amount_financed_cents;
  schedule.forEach((row, i) => {
    expect(row.month).toBe(i + 1);
    for (const value of Object.values(row)) expect(Number.isSafeInteger(value)).toBe(true);
    expect(row.payment_cents).toBe(row.interest_cents + row.principal_cents);
    balance -= row.principal_cents;
    expect(row.balance_cents).toBe(balance);
    expect(row.balance_cents).toBeGreaterThanOrEqual(0);
  });
  expect(balance).toBe(0);
  const interest = schedule.reduce((total, row) => total + row.interest_cents, 0);
  const payments = schedule.reduce((total, row) => total + row.payment_cents, 0);
  expect(option.finance_charge_cents).toBe(interest);
  expect(option.total_of_payments_cents).toBe(payments);
  expect(option.total_of_payments_cents).toBe(option.amount_financed_cents + option.finance_charge_cents);
}

const finalPayment = (option: PaymentOption): number =>
  option.schedule[option.schedule.length - 1]?.payment_cents ?? Number.NaN;

describe("golden cases", () => {
  it("case 1: fixed, $30,000.00", () => {
    const option = price("fixed_10y", "$30,000.00");
    expect(option.label).toBe("Option A");
    expect(option.payment_cents).toBe(usd("$396.29"));
    expect(finalPayment(option)).toBe(usd("$395.63"));
    expect(option.finance_charge_cents).toBe(usd("$17,554.14"));
    expect(option.total_of_payments_cents).toBe(usd("$47,554.14"));
    expect(option.schedule).toHaveLength(120);
    expect(option.amount_financed_cents).toBe(usd("$30,000.00"));
    expect(option.term_months).toBe(120);
    expect(option.apr_bps).toBe(999);
    expect(option.promo_apr_bps).toBeUndefined();
    expect(option.promo_payment_cents).toBeUndefined();
    expect(option.consequence).toBeUndefined();
    expectConsistent(option);
  });

  it("case 2: fixed, residual in the final payment, $7,500.00", () => {
    const option = price("fixed_10y", "$7,500.00");
    expect(option.payment_cents).toBe(usd("$99.07"));
    expect(finalPayment(option)).toBe(usd("$99.41"));
    expect(option.finance_charge_cents).toBe(usd("$4,388.74"));
    expect(option.total_of_payments_cents).toBe(usd("$11,888.74"));
    expectConsistent(option);
  });

  it("case 3: zero intro, $30,000.00", () => {
    const option = price("zero_intro_18m", "$30,000.00");
    expect(option.label).toBe("Option B");
    expect(option.promo_payment_cents).toBe(usd("$250.00"));
    expect(option.promo_months).toBe(18);
    expect(option.promo_apr_bps).toBe(0);
    expect(option.schedule.slice(0, 18).every((row) => row.payment_cents === usd("$250.00"))).toBe(true);
    expect(option.schedule.slice(0, 18).every((row) => row.interest_cents === 0)).toBe(true);
    expect(option.schedule[17]?.balance_cents).toBe(usd("$25,500.00"));
    expect(option.payment_cents).toBe(usd("$414.14"));
    expect(option.schedule[18]?.payment_cents).toBe(usd("$414.14"));
    expect(finalPayment(option)).toBe(usd("$413.79"));
    expect(option.finance_charge_cents).toBe(usd("$16,741.93"));
    expect(option.total_of_payments_cents).toBe(usd("$46,741.93"));
    expect(option.schedule).toHaveLength(120);
    expect(option.term_months).toBe(120);
    expect(option.apr_bps).toBe(1299);
    expectConsistent(option);
  });

  it("case 4: deferred interest, paid in full, $30,000.00", () => {
    const option = price("deferred_12m", "$30,000.00");
    expect(option.label).toBe("Option C");
    expect(option.payment_cents).toBe(usd("$2,500.00"));
    expect(option.promo_months).toBe(12);
    expect(option.schedule).toHaveLength(12);
    expect(option.schedule.every((row) => row.payment_cents === usd("$2,500.00"))).toBe(true);
    expect(option.finance_charge_cents).toBe(usd("$0.00"));
    expect(option.total_of_payments_cents).toBe(usd("$30,000.00"));
    expect(option.amount_financed_cents).toBe(usd("$30,000.00"));
    expect(option.apr_bps).toBe(1799);
    expect(option.promo_apr_bps).toBe(0);
    expectConsistent(option);
  });

  it("case 5: deferred interest, consequence, $30,000.00", () => {
    const amount = usd("$30,000.00");
    const detail = deferredConsequence(amount, product("deferred_12m"));
    expect(detail.minimum_payment_cents).toBe(usd("$250.00"));
    expect(detail.interest_added_cents).toBe(usd("$5,149.63"));
    expect(detail.balance_at_promo_end_cents).toBe(usd("$32,149.63"));
    expect(detail.payment_cents).toBe(usd("$602.83"));
    expect(detail.final_payment_cents).toBe(usd("$601.73"));
    expect(detail.total_cents).toBe(usd("$68,104.54"));
    expect(detail.finance_charge_cents).toBe(detail.total_cents - amount);

    const option = price("deferred_12m", "$30,000.00");
    expect(option.consequence).toEqual({
      interest_added_cents: usd("$5,149.63"),
      payment_cents: usd("$602.83"),
      total_cents: usd("$68,104.54"),
    });
  });

  it("a catalog with schema_version 2 throws catalog.schema_mismatch", () => {
    const err = caught(() =>
      calculate({
        amount_cents: usd("$30,000.00"),
        term_months: null,
        products: { ...CATALOG, schema_version: 2 },
      }),
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("catalog.schema_mismatch");
  });

  it("term_months 60 changes case 1's term and leaves cases 3 to 5 unchanged", () => {
    const amount = usd("$30,000.00");
    const base = calculate({ amount_cents: amount, term_months: null, products: CATALOG });
    const sixty = calculate({ amount_cents: amount, term_months: 60, products: CATALOG });
    const [fixed, zeroIntro, deferred] = sixty.options;
    expect(sixty.term_months).toBe(60);
    expect(base.term_months).toBeNull();
    expect(fixed?.term_months).toBe(60);
    expect(fixed?.schedule).toHaveLength(60);
    // Pinned from the independent Decimal reference computation, not from the design's table.
    expect(fixed?.payment_cents).toBe(usd("$637.26"));
    expect(fixed ? finalPayment(fixed) : 0).toBe(usd("$637.54"));
    expect(fixed?.finance_charge_cents).toBe(usd("$8,235.88"));
    expect(fixed?.total_of_payments_cents).toBe(usd("$38,235.88"));
    expect(zeroIntro).toEqual(base.options[1]);
    expect(deferred).toEqual(base.options[2]);
  });
});

describe("options for the whole catalog", () => {
  const result = calculate({ amount_cents: usd("$30,000.00"), term_months: null, products: CATALOG });

  it("labels the options A, B and C in catalog order", () => {
    expect(result.options.map((option) => option.label)).toEqual(["Option A", "Option B", "Option C"]);
    expect(result.options.map((option) => option.product_id)).toEqual(CATALOG.products.map((p) => p.id));
    expect(result.options.map((option) => option.product_name)).toEqual(CATALOG.products.map((p) => p.name));
    expect(result.amount_cents).toBe(usd("$30,000.00"));
    expect(result.term_months).toBeNull();
  });

  it("keeps each product's label when only some are priced", () => {
    const some = calculate({
      amount_cents: usd("$30,000.00"),
      term_months: null,
      products: CATALOG,
      product_ids: ["deferred_12m", "fixed_10y"],
    });
    expect(some.options.map((option) => [option.label, option.product_id])).toEqual([
      ["Option A", "fixed_10y"],
      ["Option C", "deferred_12m"],
    ]);
    expect(some.options[0]).toEqual(result.options[0]);
    expect(some.options[1]).toEqual(result.options[2]);
  });

  it("ties each plain sentence to its option label", () => {
    result.options.forEach((option, i) => {
      expect(CATALOG.products[i]?.plain_sentence.startsWith(`${option.label} `)).toBe(true);
    });
  });
});

describe("catalog", () => {
  it("holds the three products of the design, in order", () => {
    expect(CATALOG.schema_version).toBe(CATALOG_SCHEMA_VERSION);
    expect(
      CATALOG.products.map((p) => [p.id, p.name, p.mechanic, p.term_months, p.apr_bps, p.promo_months, p.standard_apr_bps]),
    ).toEqual([
      ["fixed_10y", "10-year fixed", "fixed", 120, 999, null, 999],
      ["zero_intro_18m", "0% for 18 months", "zero_intro", 120, 1299, 18, 1299],
      ["deferred_12m", "12 months deferred interest", "deferred_interest", 120, 1799, 12, 1799],
    ]);
    expect(CatalogSchema.safeParse(CATALOG).success).toBe(true);
    for (const p of CATALOG.products) {
      expect(p.plain_sentence.length).toBeGreaterThan(0);
      expect(p.rules.length).toBeGreaterThan(0);
    }
  });

  it("is what the catalog service serves", async () => {
    const served = await services.catalog.getCatalog();
    expect(served).toEqual(CATALOG);
    expect(served).not.toBe(CATALOG);
  });

  it("rejects a malformed product row as a schema mismatch", () => {
    const [fixed, zeroIntro, deferred] = CATALOG.products as [CatalogProduct, CatalogProduct, CatalogProduct];
    const variants: Catalog[] = [
      // a promotional product without its promotional period
      { ...CATALOG, products: [fixed, { ...zeroIntro, promo_months: null }, deferred] },
      // a promotion as long as the term
      { ...CATALOG, products: [fixed, { ...zeroIntro, promo_months: 120 }, deferred] },
      // an APR of 0 on the balance would print 0.00% in the disclosure's APR cell
      { ...CATALOG, products: [fixed, { ...zeroIntro, apr_bps: 0 }, deferred] },
      // more products than option labels
      { ...CATALOG, products: [fixed, zeroIntro, deferred, { ...fixed }] },
    ];
    for (const products of variants) {
      const err = caught(() => calculate({ amount_cents: 1_000_000, term_months: null, products }));
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("catalog.schema_mismatch");
    }
  });
});

describe("catalog bounds", () => {
  const [fixed, zeroIntro, deferred] = CATALOG.products as [CatalogProduct, CatalogProduct, CatalogProduct];
  const withProducts = (...products: CatalogProduct[]): Catalog => ({ ...CATALOG, products });
  const mismatch = (catalog: Catalog): unknown =>
    caught(() => calculate({ amount_cents: 1_000_000, term_months: null, products: catalog }));

  it("rejects a product term outside 1 to the maximum term", () => {
    for (const term_months of [1_000_000_000, MAX_TERM_MONTHS + 1, 0]) {
      for (const [name, bad] of [
        ["fixed", { ...fixed, term_months }],
        ["zero_intro", { ...zeroIntro, term_months }],
        ["deferred_interest", { ...deferred, term_months }],
      ] as const) {
        const catalog =
          name === "fixed" ? withProducts(bad, zeroIntro, deferred)
          : name === "zero_intro" ? withProducts(fixed, bad, deferred)
          : withProducts(fixed, zeroIntro, bad);
        const err = mismatch(catalog);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("catalog.schema_mismatch");
      }
    }
  });

  it("accepts a term at the maximum", () => {
    const longer = withProducts({ ...fixed, term_months: MAX_TERM_MONTHS }, zeroIntro, deferred);
    expect(() => calculate({ amount_cents: 1_000_000, term_months: null, products: longer })).not.toThrow();
  });

  it("rejects an APR above 100000 basis points, whichever APR field carries it", () => {
    for (const apr_bps of [1_000_000, 100_001]) {
      for (const bad of [
        withProducts({ ...fixed, apr_bps, standard_apr_bps: apr_bps }, zeroIntro, deferred),
        withProducts(fixed, { ...zeroIntro, apr_bps, standard_apr_bps: apr_bps }, deferred),
        withProducts(fixed, zeroIntro, { ...deferred, standard_apr_bps: apr_bps }),
        withProducts({ ...fixed, apr_bps }, zeroIntro, deferred),
      ]) {
        const err = mismatch(bad);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("catalog.schema_mismatch");
      }
    }
  });

  it("rejects a promotional rate on a catalog row, which the strict schema does not define", () => {
    const withPromoRate = { ...zeroIntro, promo_apr_bps: 1_000_000 } as unknown as CatalogProduct;
    const err = mismatch(withProducts(fixed, withPromoRate, deferred));
    expect((err as AppError).code).toBe("catalog.schema_mismatch");
  });

  it("accepts an APR at 100000 basis points", () => {
    const steep = withProducts({ ...fixed, apr_bps: 100_000, standard_apr_bps: 100_000 }, zeroIntro, deferred);
    expect(() => calculate({ amount_cents: 1_000_000, term_months: null, products: steep })).not.toThrow();
  });

  it("rejects a promotional period of 0 or as long as the term", () => {
    for (const promo_months of [0, 120, 121]) {
      const err = mismatch(withProducts(fixed, { ...zeroIntro, promo_months }, deferred));
      expect((err as AppError).code).toBe("catalog.schema_mismatch");
    }
    const edge = withProducts(fixed, { ...zeroIntro, promo_months: 119 }, deferred);
    expect(() => calculate({ amount_cents: 1_000_000, term_months: null, products: edge })).not.toThrow();
  });

  it("rejects a repeated product id, even when the catalog is no longer than the option labels", () => {
    const duplicated = withProducts(fixed, { ...fixed }, deferred);
    expect(duplicated.products).toHaveLength(CATALOG.products.length);
    const err = mismatch(duplicated);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("catalog.schema_mismatch");
    const adjacent = mismatch(withProducts(fixed, fixed, zeroIntro));
    expect((adjacent as AppError).code).toBe("catalog.schema_mismatch");
  });
});

describe("arithmetic", () => {
  it("rounds half-even in exact integer arithmetic", () => {
    expect(divideRoundHalfEven(1, 2)).toBe(0);
    expect(divideRoundHalfEven(3, 2)).toBe(2);
    expect(divideRoundHalfEven(5, 2)).toBe(2);
    expect(divideRoundHalfEven(7, 2)).toBe(4);
    expect(divideRoundHalfEven(10, 4)).toBe(2);
    expect(divideRoundHalfEven(14, 4)).toBe(4);
    expect(divideRoundHalfEven(9, 4)).toBe(2);
    expect(divideRoundHalfEven(11, 4)).toBe(3);
    expect(divideRoundHalfEven(0, 7)).toBe(0);
    expect(() => divideRoundHalfEven(-1, 2)).toThrow(RangeError);
    expect(() => divideRoundHalfEven(1.5, 2)).toThrow(RangeError);
    expect(() => divideRoundHalfEven(1, 0)).toThrow(RangeError);
  });

  /** A catalog whose fixed product charges `bps`, for pinning exact rounding ties. */
  function fixedAt(bps: number): Catalog {
    return {
      ...CATALOG,
      products: [{ ...product("fixed_10y"), apr_bps: bps, standard_apr_bps: bps }, ...CATALOG.products.slice(1)],
    };
  }

  it("rounds a monthly interest of exactly half a cent to the even cent", () => {
    // 12.00% APR is 1% a month: $2.50 owes 2.5 cents, which half-even rounds to 2 (half-up would give 3).
    const tie = fixedAt(1200);
    const result = calculate({ amount_cents: 250, term_months: 12, products: tie, product_ids: ["fixed_10y"] });
    const option = result.options[0];
    expect(option?.schedule[0]).toEqual({
      month: 1,
      payment_cents: 22,
      interest_cents: 2,
      principal_cents: 20,
      balance_cents: 230,
    });
    // Pinned from the independent Decimal reference computation.
    expect(option?.finance_charge_cents).toBe(16);
    expect(option?.total_of_payments_cents).toBe(266);
    if (option) expectConsistent(option);
  });

  it("rounds an exact half-cent level payment to the even cent, in line with the schedule", () => {
    // 350 cents at 12.00% for one month owes 350 x 1.01 = 353.5 cents. Half-even is 354 (353 is odd);
    // a float computation lands on 353 and then disagrees with the schedule's final payment.
    expect(levelPaymentCents(350, 1200, 1)).toBe(354);
    const result = calculate({ amount_cents: 350, term_months: 1, products: fixedAt(1200), product_ids: ["fixed_10y"] });
    const option = result.options[0];
    expect(option?.payment_cents).toBe(354);
    expect(option ? finalPayment(option) : 0).toBe(354);
    expect(option?.finance_charge_cents).toBe(4);
    expect(option?.total_of_payments_cents).toBe(354);
    if (option) expectConsistent(option);
  });

  it("makes a one-month level payment equal the schedule's single payment, ties included", () => {
    // For one month the level payment P (1 + r) is P plus that month's interest, so the payment
    // and the schedule's only row agree. The one exception is an exact half-cent on an odd
    // principal: rounding P + x as a whole and rounding x alone then land on different cents, and
    // the exact rational wins (levelPaymentCents is the exact rational, rounded once).
    let compared = 0;
    for (const bps of [1, 600, 800, 1200, 1299, 3600, 100_000]) {
      for (let principal = 1; principal <= 1_500; principal += 1) {
        const exactHalf = (principal * bps * 2) % 120_000 === 0 && (principal * bps) % 120_000 !== 0;
        if (exactHalf && principal % 2 === 1) continue;
        expect(levelPaymentCents(principal, bps, 1)).toBe(principal + divideRoundHalfEven(principal * bps, 120_000));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(10_000);
  });

  it("matches an exact rational computation of the level payment", () => {
    // payment = P r / (1 - (1 + r)^-n) with r = bps / 120000, as one fraction of BigInts, rounded half-even.
    function exactLevelPayment(principal: number, bps: number, months: number): number {
      const d = 120_000n;
      const n = d + BigInt(bps);
      const nPow = n ** BigInt(months);
      const dPow = d ** BigInt(months);
      const numerator = BigInt(principal) * BigInt(bps) * nPow;
      const denominator = d * (nPow - dPow);
      let quotient = numerator / denominator;
      const twice = (numerator % denominator) * 2n;
      if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
      return Number(quotient);
    }
    let checked = 0;
    for (const principal of [100, 12_345, 750_000, 3_000_000, 3_000_001, 99_999_999, 1_234_567_891]) {
      for (const bps of [1, 999, 1299, 1799, 3600]) {
        for (const months of [12, 60, 102, 108, 120, 180, 240, 600]) {
          expect(levelPaymentCents(principal, bps, months)).toBe(exactLevelPayment(principal, bps, months));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(280);
  });

  it("returns whole cents and a closed schedule for every product, amount and term", () => {
    const amounts = [1, 7, 100, 12_345, 750_000, 750_001, 3_000_000, 3_000_001, 49_999_999, MAX_AMOUNT_CENTS];
    for (const amount_cents of amounts) {
      for (const term_months of [null, 1, 12, 60, 84, 120, 180, 600]) {
        const result = calculate({ amount_cents, term_months, products: CATALOG });
        for (const option of result.options) {
          expectConsistent(option);
          for (const value of [
            option.payment_cents,
            option.finance_charge_cents,
            option.total_of_payments_cents,
            option.consequence?.interest_added_cents ?? 0,
            option.consequence?.payment_cents ?? 0,
            option.consequence?.total_cents ?? 0,
          ]) {
            expect(Number.isSafeInteger(value)).toBe(true);
          }
        }
      }
    }
  });

  it("prices the largest amount at the largest APR and term as whole, closed schedules", () => {
    const steep: Catalog = {
      ...CATALOG,
      products: CATALOG.products.map((p) => ({ ...p, term_months: MAX_TERM_MONTHS, apr_bps: 100_000, standard_apr_bps: 100_000 })),
    };
    const result = calculate({ amount_cents: MAX_AMOUNT_CENTS, term_months: MAX_TERM_MONTHS, products: steep });
    expect(result.options).toHaveLength(3);
    for (const option of result.options) {
      expectConsistent(option);
      for (const value of [option.payment_cents, option.finance_charge_cents, option.consequence?.total_cents ?? 0]) {
        expect(Number.isSafeInteger(value)).toBe(true);
      }
    }
  });

  it("leaves a deferred-interest residual in the last payment", () => {
    const option = price("deferred_12m", "$30,000.01");
    expect(option.payment_cents).toBe(usd("$2,500.00"));
    expect(finalPayment(option)).toBe(usd("$2,500.01"));
    expect(option.total_of_payments_cents).toBe(usd("$30,000.01"));
  });
});

describe("inputs", () => {
  const price60 = (amount_cents: number, term_months: number | null) =>
    calculate({ amount_cents, term_months, products: CATALOG });

  it("rejects an amount that is not a positive whole number of cents within bounds", () => {
    for (const amount of [0, -100, 12.5, Number.NaN, MAX_AMOUNT_CENTS + 1]) {
      const err = caught(() => price60(amount, null));
      expect(err).toBeInstanceOf(CommandError);
      expect((err as CommandError).message).toContain(formatMoney(MAX_AMOUNT_CENTS));
    }
  });

  it("rejects a term that is not a whole number of months within bounds", () => {
    for (const term of [0, -12, 60.5, 601]) {
      expect(caught(() => price60(1_000_000, term))).toBeInstanceOf(CommandError);
    }
  });

  it("rejects an empty or unknown product selection", () => {
    const call = (product_ids: string[]) =>
      calculate({ amount_cents: 1_000_000, term_months: null, products: CATALOG, product_ids });
    expect(caught(() => call([]))).toBeInstanceOf(CommandError);
    expect(caught(() => call(["no_such_product"]))).toBeInstanceOf(CommandError);
  });
});

describe("calculatorValues", () => {
  const sorted = (values: string[]): string[] => [...values].sort();

  it("lists case 1's figures through the shared formatters", () => {
    const values = calculatorValues(price("fixed_10y", "$30,000.00"));
    expect(sorted(values)).toEqual(
      sorted(["$396.29", "9.99%", "$17,554.14", "$30,000.00", "$47,554.14", "120 months", "10 years"]),
    );
  });

  it("lists case 3's promo payment, promo rate and month counts", () => {
    const values = calculatorValues(price("zero_intro_18m", "$30,000.00"));
    expect(sorted(values)).toEqual(
      sorted([
        "$414.14",
        "$250.00",
        "12.99%",
        "0.00%",
        "$16,741.93",
        "$30,000.00",
        "$46,741.93",
        "120 months",
        "10 years",
        "18 months",
        "102 months",
      ]),
    );
  });

  it("lists case 5's consequence figures", () => {
    const values = calculatorValues(price("deferred_12m", "$30,000.00"));
    expect(sorted(values)).toEqual(
      sorted([
        "$2,500.00",
        "$602.83",
        "17.99%",
        "0.00%",
        "$0.00",
        "$30,000.00",
        "$68,104.54",
        "$5,149.63",
        "120 months",
        "10 years",
        "12 months",
        "108 months",
      ]),
    );
  });

  it("lists a figure once, spells the term in years for every term, and is recognized by the figure normalizer", () => {
    const sixty = price("fixed_10y", "$30,000.00", 60);
    const values = calculatorValues(sixty);
    expect(values).toContain("60 months");
    expect(values).toContain("5 years");
    expect(new Set(values).size).toBe(values.length);

    const all = calculatorValuesForResult(
      calculate({ amount_cents: usd("$30,000.00"), term_months: null, products: CATALOG }),
    );
    expect(new Set(all).size).toBe(all.length);
    for (const value of all) expect(normalizeFigure(value)).not.toBeNull();
  });

  it("spells an odd term with one decimal where exact and two decimals otherwise", () => {
    const years = (term: number): string[] =>
      calculatorValues(price("fixed_10y", "$30,000.00", term)).filter((value) => value.endsWith(" years"));
    expect(years(90)).toEqual(["7.5 years"]);
    expect(years(6)).toEqual(["0.5 years"]);
    expect(years(18)).toEqual(["1.5 years"]);
    expect(years(3)).toEqual(["0.25 years"]);
    expect(years(100)).toEqual(["8.33 years"]);
    expect(years(1)).toEqual(["0.08 years"]);
    expect(years(7)).toEqual(["0.58 years"]);
    expect(years(125)).toEqual(["10.42 years"]);
    expect(years(12)).toEqual(["1 years"]);
    expect(years(120)).toEqual(["10 years"]);
    expect(calculatorValues(price("fixed_10y", "$30,000.00", 90))).toContain("90 months");
  });

  it("computes the months that follow a promotion", () => {
    expect(monthsAfterPromo(price("fixed_10y", "$30,000.00"))).toBe(120);
    expect(monthsAfterPromo(price("zero_intro_18m", "$30,000.00"))).toBe(102);
    expect(monthsAfterPromo(price("deferred_12m", "$30,000.00"))).toBe(108);
  });
});
