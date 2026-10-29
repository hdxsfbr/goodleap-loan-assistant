import { describe, expect, it } from "vitest";
import { decimalTermTokens, figureTokens, normalizeFigure } from "@shared/normalize";
import type { GuardrailAllowed } from "@shared/schemas";
import { CATALOG } from "../server/domain/catalog.js";
import { calculate, calculatorValues, calculatorValuesForResult } from "../server/domain/payments/calculator.js";
import { allFigureTokens, checkNumberMatch } from "../server/guardrail/number-match.js";
import { usdToCents } from "./helpers/money.js";

// Item 75: the number-match check. No key needed.

function calculation(amount: string, term: number | null = null, product_ids?: string[]) {
  return calculate({
    amount_cents: usdToCents(amount),
    term_months: term,
    products: CATALOG,
    ...(product_ids ? { product_ids } : {}),
  });
}

/**
 * The allowed set of a turn: the calculation's values (if any), each option's own values, and the
 * figures in the contractor's message.
 */
function allowed(contractorMessage: string, result?: ReturnType<typeof calculation>): GuardrailAllowed {
  return {
    calculator_values: result ? calculatorValuesForResult(result) : [],
    contractor_figures: allFigureTokens(contractorMessage),
    ...(result
      ? { option_values: Object.fromEntries(result.options.map((option) => [option.label, calculatorValues(option)])) }
      : {}),
  };
}

const all30k = calculation("$30,000.00");

describe("number-match", () => {
  it("passes verbatim calculator figures, the contractor's own figures and the term", () => {
    const set = allowed("The project is $30K. What would the payment look like?", all30k);
    const prose =
      "Option A is a fixed-rate loan at 9.99% APR: $396.29 a month for 120 months, $47,554.14 in total, on the $30K project. " +
      "Option B is $250.00 a month for the first 18 months at 0.00%, then $414.14 for 102 months.";
    const verdict = checkNumberMatch(prose, set);
    expect(verdict).toEqual({ pass: true, layer: "number_match", outcome: "pass" });
  });

  it("spells figures alike however they are written", () => {
    const set = allowed("Make it $40K", all30k);
    expect(checkNumberMatch("Use $40,000 as the requested amount?", set).pass).toBe(true);
    expect(checkNumberMatch("About $30,000 financed over 10 years.", set).pass).toBe(true);
    expect(checkNumberMatch("That is $396.29 a month.", set).pass).toBe(true);
    expect(checkNumberMatch("That is $396.3 a month.", set).pass).toBe(false);
  });

  it.each([
    ["about $300 a month", "300.00"],
    ["over 15 years", "15 years"],
  ])("blocks %s", (prose, offending) => {
    const verdict = checkNumberMatch(prose, allowed("The project is $30K.", all30k));
    expect(verdict.pass).toBe(false);
    expect(verdict.outcome).toBe("blocked");
    expect(verdict.matched?.join(" ")).toContain(offending);
  });

  it("blocks a payment that belongs to a product the calculation did not price", () => {
    const optionAOnly = calculation("$30,000.00", null, ["fixed_10y"]);
    const set = allowed("The project is $30K.", optionAOnly);
    expect(checkNumberMatch("Option A is $396.29 a month.", set).pass).toBe(true);
    const verdict = checkNumberMatch("Option A is $414.14 a month.", set);
    expect(verdict.pass).toBe(false);
    expect(verdict.matched).toEqual(["$414.14"]);
  });

  it("blocks an invented payment when no calculation ran, but still allows the contractor's figures", () => {
    const set = allowed("The project is $30K.");
    expect(set.calculator_values).toEqual([]);
    expect(checkNumberMatch("That would be about $350 a month.", set).matched).toEqual(["$350.00"]);
    expect(checkNumberMatch("The project is $30,000.", set).pass).toBe(true);
    expect(checkNumberMatch("Option B describes a 0% period for 18 months.", set).pass).toBe(false);
    expect(checkNumberMatch("Option B has an introductory period with no interest.", set).pass).toBe(true);
  });

  it("returns each offending figure once", () => {
    const verdict = checkNumberMatch("$300 now, $300 later, and 15 years.", allowed("hi"));
    expect(verdict.matched).toEqual(["$300.00", "15 years"]);
  });

  describe("terms with a decimal count", () => {
    const ninety = calculation("$30,000.00", 90, ["fixed_10y"]);
    const set = allowed("What about 7.5 years? The project is $30K.", ninety);

    it("reads a decimal term in prose and in the allowed list", () => {
      expect(calculatorValuesForResult(ninety)).toContain("7.5 years");
      expect(normalizeFigure("7.5 years")).toBe("7.5 years");
      expect(normalizeFigure("7.50 years")).toBe("7.5 years");
      expect(decimalTermTokens("over 8.33 years, or 0.25 year, or 18 months")).toEqual(["8.33 years", "0.25 years"]);
      expect(allFigureTokens("over 7.5 years or 90 months")).toEqual(["90 months", "7.5 years"]);
    });

    it("passes the exact decimal term and blocks any other", () => {
      expect(checkNumberMatch("Option A runs 90 months, which is 7.5 years.", set).pass).toBe(true);
      const verdict = checkNumberMatch("Option A runs about 7.6 years.", set);
      expect(verdict.pass).toBe(false);
      expect(verdict.matched).toEqual(["7.6 years"]);
      expect(checkNumberMatch("Option A runs 8.33 years.", set).matched).toEqual(["8.33 years"]);
    });

    it("leaves figureTokens' whole-number behavior unchanged", () => {
      expect(figureTokens("1.5 years")).toEqual([]);
    });
  });
});

describe("figures written with a unit word or in words", () => {
  const noCalculation = allowed("What would the payment be?");

  it.each([
    ["350 dollars", ["350.00"]],
    ["350 per month", ["350.00"]],
    ["350 a month", ["350.00"]],
    ["350/mo", ["350.00"]],
    ["350 / month", ["350.00"]],
    ["350 bucks", ["350.00"]],
    ["350-dollar", ["350.00"]],
    ["1,234.50 dollars", ["1234.50"]],
    ["30K dollars", ["30000.00"]],
    ["three hundred dollars", ["300.00"]],
    ["three hundred fifty dollars a month", ["350.00"]],
    ["a thousand dollars", ["1000.00"]],
    ["ten years", ["10 years"]],
    ["Ten-year", ["10 years"]],
    ["twelve months", ["12 months"]],
    ["eighteen months", ["18 months"]],
    ["twenty-one months", ["21 months"]],
    ["twelve percent", ["12%"]],
  ])("reads %s as a figure", (text, tokens) => {
    expect(figureTokens(text)).toEqual(tokens);
  });

  it.each([
    ["There are 4 line items and 12 feet.", []],
    ["120 monthly payments of $396.29", ["396.29"]],
    ["twice a month", []],
    ["someone months", []],
    ["Option A is one of three options.", []],
  ])("does not read a figure that is not one in %s", (text, tokens) => {
    expect(figureTokens(text)).toEqual(tokens);
  });

  it.each([
    ["That would be 350 dollars.", "$350.00"],
    ["That would be 350 per month.", "$350.00"],
    ["That would be about 350 a month.", "$350.00"],
    ["That would be 350/mo.", "$350.00"],
    ["That would be 350 bucks.", "$350.00"],
    ["That would be three hundred dollars.", "$300.00"],
    ["The loan runs ten years.", "10 years"],
    ["The promotion lasts eighteen months.", "18 months"],
  ])("blocks an invented figure in %s", (prose, offending) => {
    const verdict = checkNumberMatch(prose, noCalculation);
    expect(verdict.pass).toBe(false);
    expect(verdict.matched).toEqual([offending]);
  });

  it.each([
    ["That would be 350 dollars.", "The payment is $350."],
    ["That would be 350 a month.", "Could it be $350 a month?"],
    ["That would be three hundred fifty dollars.", "I think $350."],
    ["The loan runs ten years.", "She wants a 10-year loan."],
  ])("passes %s when the contractor typed the figure", (prose, contractorMessage) => {
    expect(checkNumberMatch(prose, allowed(contractorMessage)).pass).toBe(true);
  });

  it("passes spelled terms and unit-word amounts that are the calculation's own figures", () => {
    const set = allowed("What is the payment on $30K?", all30k);
    expect(checkNumberMatch("Option A runs ten years.", set).pass).toBe(true);
    expect(checkNumberMatch("Option B has eighteen months with no interest.", set).pass).toBe(true);
    expect(checkNumberMatch("Option C needs the balance paid within twelve months.", set).pass).toBe(true);
    expect(checkNumberMatch("Option A is 396.29 dollars a month.", set).pass).toBe(true);
    expect(checkNumberMatch("Option A is eleven years.", set).matched).toEqual(["11 years"]);
    expect(checkNumberMatch("Option A is 396.30 dollars a month.", set).matched).toEqual(["$396.30"]);
  });

  it("does not take a count of payments for an amount", () => {
    const set = allowed("What is the payment on $30K?", all30k);
    expect(checkNumberMatch("Option A has 120 monthly payments of $396.29.", set).pass).toBe(true);
    expect(checkNumberMatch("Option B has 18 monthly payments of $250.00, then 102 monthly payments of $414.14.", set).pass).toBe(true);
  });
});

describe("a figure belongs to the option it is attached to", () => {
  const set = allowed("What would the payments be on $30K?", all30k);

  it("blocks Option B's payment attached to Option A, and passes it on Option B", () => {
    const wrong = checkNumberMatch("Option A is $414.14 a month.", set);
    expect(wrong.pass).toBe(false);
    expect(wrong.outcome).toBe("blocked");
    expect(wrong.matched).toEqual(["$414.14"]);
    expect(wrong.reason).toContain("Option A");

    expect(checkNumberMatch("Option B is $414.14 a month after the first 18 months.", set)).toEqual({
      pass: true,
      layer: "number_match",
      outcome: "pass",
    });
  });

  it("checks every product's own figures, not just Option A's", () => {
    expect(checkNumberMatch("Option C is $396.29 a month.", set).matched).toEqual(["$396.29"]);
    expect(checkNumberMatch("Option B is $2,500.00 a month.", set).matched).toEqual(["$2500.00"]);
    expect(checkNumberMatch("Option C is $2,500.00 a month if paid in full within 12 months.", set).pass).toBe(true);
    expect(checkNumberMatch("Option A is $250.00 a month for the first 18 months.", set).pass).toBe(false);
  });

  it("applies per sentence, and lets an option's own figures and the contractor's through", () => {
    const prose =
      "Option A is $396.29 a month on the $30K project. Option B is $250.00 a month, then $414.14. " +
      "Option C is $2,500.00 a month.";
    expect(checkNumberMatch(prose, set).pass).toBe(true);
    expect(checkNumberMatch("Option A is $396.29 a month. Option B is $396.29 a month.", set).matched).toEqual(["$396.29"]);
    // Clauses split at semicolons and line breaks too.
    expect(checkNumberMatch("Option A is $396.29 a month; Option B is $396.29 a month", set).pass).toBe(false);
    expect(checkNumberMatch("Option A: $396.29 a month\nOption B: $396.29 a month", set).pass).toBe(false);
  });

  it("keeps the whole-calculation rule for a sentence that names no option or several", () => {
    expect(checkNumberMatch("The payments are $396.29 and $414.14.", set).pass).toBe(true);
    expect(checkNumberMatch("Option A is $396.29 a month and Option B is $414.14 after the promotion.", set).pass).toBe(true);
    expect(checkNumberMatch("The payment is $350.00.", set).matched).toEqual(["$350.00"]);
  });

  it("binds only money: a rate or a term in the sentence follows the whole-calculation rule", () => {
    expect(checkNumberMatch("Option A has a promotional period of 18 months.", set).pass).toBe(true);
    expect(checkNumberMatch("Option A is at 0.00% for a while.", set).pass).toBe(true);
  });

  it("treats an option the calculation did not price as having no figures of its own", () => {
    const optionAOnly = allowed("The project is $30K.", calculation("$30,000.00", null, ["fixed_10y"]));
    expect(checkNumberMatch("Option B is $396.29 a month.", optionAOnly).matched).toEqual(["$396.29"]);
    expect(checkNumberMatch("Option B is on the $30K project.", optionAOnly).pass).toBe(true);
  });

  it("is off when the per-option values are not given", () => {
    const { option_values: _omitted, ...global } = set;
    expect(checkNumberMatch("Option A is $414.14 a month.", global).pass).toBe(true);
  });

  it("names both the offending figure and the option in the reason", () => {
    const reason = checkNumberMatch("Option A is $414.14 a month, and it is $350 a month.", set).reason ?? "";
    expect(reason).toContain("$350.00");
    expect(reason).toContain("$414.14");
    expect(reason).toContain("Option A");
  });
});
