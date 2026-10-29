import { describe, expect, it } from "vitest";
import { fillableFields } from "@shared/application-schema";
import { PRODUCT_IDS } from "@shared/catalog-ids";
import {
  CALCULATE_PAYMENT,
  CalculatePaymentArgsSchema,
  FILLABLE_FIELD_IDS,
  PROPOSE_FIELD_FILL,
  ProposeFieldFillArgsSchema,
  TOOLS,
} from "../server/copilot/tools.js";

// Item 80: the generated tool schemas follow the single sources of truth. No key needed.

const byName = (name: string) => {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};
const properties = (name: string) => byName(name).input_schema.properties as Record<string, Record<string, unknown>>;

describe("copilot tools", () => {
  it("has the two tools in a fixed order", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([CALCULATE_PAYMENT, PROPOSE_FIELD_FILL]);
  });

  it("generates the propose_field_fill field enum from fillableFields()", () => {
    expect(properties(PROPOSE_FIELD_FILL).field?.enum).toEqual(fillableFields().map((field) => field.id));
    expect(FILLABLE_FIELD_IDS).toEqual(fillableFields().map((field) => field.id));
    // The decision-engine inputs are never offered to the model.
    expect(properties(PROPOSE_FIELD_FILL).field?.enum).not.toContain("stated_annual_income");
  });

  it("generates the calculate_payment product enum from PRODUCT_IDS", () => {
    const items = properties(CALCULATE_PAYMENT).product_ids?.items as { enum: string[] };
    expect(items.enum).toEqual([...PRODUCT_IDS]);
  });

  it("is strict, closed and fully required, as strict mode needs", () => {
    for (const tool of TOOLS) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect([...(tool.input_schema.required ?? [])].sort()).toEqual(Object.keys(tool.input_schema.properties as object).sort());
      expect(tool.description?.length).toBeGreaterThan(40);
    }
  });

  it("takes the term as an integer or null", () => {
    expect(properties(CALCULATE_PAYMENT).term_months?.anyOf).toEqual([{ type: "integer" }, { type: "null" }]);
    expect(properties(CALCULATE_PAYMENT).amount_cents?.type).toBe("integer");
  });

  it("validates arguments beyond the JSON schema", () => {
    const good = { amount_cents: 3_000_000, term_months: null, product_ids: ["fixed_10y"] };
    expect(CalculatePaymentArgsSchema.safeParse(good).success).toBe(true);
    expect(CalculatePaymentArgsSchema.safeParse({ ...good, amount_cents: 0 }).success).toBe(false);
    expect(CalculatePaymentArgsSchema.safeParse({ ...good, amount_cents: 30.5 }).success).toBe(false);
    expect(CalculatePaymentArgsSchema.safeParse({ ...good, product_ids: ["nope"] }).success).toBe(false);

    const fill = { field: "project_amount", value: "$30K", message_id: "m_1", verbatim_quote: "$30K" };
    expect(ProposeFieldFillArgsSchema.safeParse(fill).success).toBe(true);
    expect(ProposeFieldFillArgsSchema.safeParse({ ...fill, field: "stated_annual_income" }).success).toBe(false);
    expect(ProposeFieldFillArgsSchema.safeParse({ ...fill, verbatim_quote: " " }).success).toBe(false);
  });
});
