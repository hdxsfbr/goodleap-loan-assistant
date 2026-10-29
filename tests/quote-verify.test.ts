import { describe, expect, it } from "vitest";
import { fieldDef, zodForField } from "@shared/application-schema";
import { quoteSupportsValue, verifyQuote } from "../server/copilot/quote-verify.js";

// Item 80: a proposal's quote must appear word for word in the message it cites. No key needed.

const FIRST = "The project is $30K and the homeowner is Dana Lee. She wants the 10-year option.";
const SECOND = "Her zip is 94105, near the bay.";

describe("verifyQuote", () => {
  it("passes a verbatim quote", () => {
    expect(verifyQuote("She wants the 10-year option", FIRST).ok).toBe(true);
    expect(verifyQuote("The project is $30K", FIRST)).toEqual({ ok: true, normalized_quote: "the project is 30k" });
  });

  it("passes a quote that differs only in case, spacing and punctuation", () => {
    expect(verifyQuote("the  project IS $30K.", FIRST).ok).toBe(true);
    expect(verifyQuote("Dana Lee,", FIRST).ok).toBe(true);
  });

  it("fails a paraphrase", () => {
    expect(verifyQuote("she wants ten years", FIRST).ok).toBe(false);
    expect(verifyQuote("The project costs $30,000", FIRST).ok).toBe(false);
  });

  it("fails a quote that belongs to another message", () => {
    expect(verifyQuote("Her zip is 94105", FIRST).ok).toBe(false);
    expect(verifyQuote("Her zip is 94105", SECOND).ok).toBe(true);
    expect(verifyQuote("She wants the 10-year option", SECOND).ok).toBe(false);
  });

  it("fails a partial word and an empty quote", () => {
    expect(verifyQuote("The proj", FIRST).ok).toBe(false);
    expect(verifyQuote("", FIRST)).toEqual({ ok: false, normalized_quote: "" });
    expect(verifyQuote("  ...  ", FIRST).ok).toBe(false);
  });

  it("does not accept words in a different order", () => {
    expect(verifyQuote("30K is the project", FIRST).ok).toBe(false);
  });
});

describe("quoteSupportsValue", () => {
  /** Whether the quote supports the value the field would store for what the model wrote. */
  function supports(field: string, stated: string, quote: string): boolean {
    const def = fieldDef(field);
    if (!def) throw new Error(`no field ${field}`);
    const parsed = zodForField(field).parse(stated);
    return quoteSupportsValue(def, stated, parsed, quote);
  }

  it("needs a money quote to state the amount proposed", () => {
    expect(supports("project_amount", "$30K", "The project is $30K")).toBe(true);
    expect(supports("project_amount", "$40K", "The project is $30K")).toBe(false);
    expect(supports("project_amount", "30000", "The project is $30,000.00")).toBe(true);
    expect(supports("project_amount", "$30,000", "30K")).toBe(true);
    expect(supports("project_amount", "$30,000", "thirty thousand dollars")).toBe(true);
    expect(supports("project_amount", "$30,000", "30 thousand")).toBe(true);
    expect(supports("requested_loan_amount", "$42,500", "the loan is $42.5K")).toBe(true);
    expect(supports("requested_loan_amount", "$42,500", "the loan is $24,500")).toBe(false);
    expect(supports("project_amount", "$30K", "the project, no amount yet")).toBe(false);
  });

  it("needs a name or ZIP quote to contain the value", () => {
    expect(supports("homeowner_first_name", "Maria", "Homeowner is Maria Lopez")).toBe(true);
    expect(supports("homeowner_last_name", "Lopez", "Homeowner is Maria Lopez")).toBe(true);
    expect(supports("homeowner_first_name", "Dana", "Homeowner is Maria Lopez")).toBe(false);
    expect(supports("homeowner_first_name", "Mari", "Homeowner is Maria Lopez")).toBe(false);
    expect(supports("property_zip", "95112", "zip 95112")).toBe(true);
    expect(supports("property_zip", "95113", "zip 95112")).toBe(false);
    expect(supports("project_description", "full roof replacement", "she wants a full roof replacement")).toBe(true);
    expect(supports("project_description", "kitchen remodel", "she wants a full roof replacement")).toBe(false);
  });

  it("needs an enum quote to state the option, in any of the ways a contractor says it", () => {
    expect(supports("project_type", "roofing", "it is a roofing job")).toBe(true);
    expect(supports("project_type", "roofing", "she needs a new roof")).toBe(true);
    expect(supports("project_type", "solar", "it is a roofing job")).toBe(false);
    expect(supports("project_type", "kitchen_bath", "a kitchen remodel")).toBe(true);
    expect(supports("project_type", "windows_doors", "new windows for the whole house")).toBe(true);
    expect(supports("project_type", "hvac", "a kitchen remodel")).toBe(false);

    expect(supports("preferred_term_months", "120", "she wants the 10-year option")).toBe(true);
    expect(supports("preferred_term_months", "120", "make it ten years")).toBe(true);
    expect(supports("preferred_term_months", "120", "120 months")).toBe(true);
    expect(supports("preferred_term_months", "180", "she wants the 10-year option")).toBe(false);
    expect(supports("preferred_term_months", "60", "she wants a five-year term")).toBe(true);

    expect(supports("selected_product_id", "fixed_10y", "she wants the 10-year option")).toBe(true);
    expect(supports("selected_product_id", "fixed_10y", "the fixed one")).toBe(true);
    expect(supports("selected_product_id", "zero_intro_18m", "she likes Option B")).toBe(true);
    expect(supports("selected_product_id", "zero_intro_18m", "the 0% for 18 months")).toBe(true);
    expect(supports("selected_product_id", "deferred_12m", "the deferred interest one")).toBe(true);
    expect(supports("selected_product_id", "zero_intro_18m", "she wants the 10-year option")).toBe(false);
    expect(supports("selected_product_id", "deferred_12m", "she likes Option A")).toBe(false);
  });
});
