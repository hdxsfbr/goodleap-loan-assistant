// The two copilot tools, as `Anthropic.Tool` objects with `strict: true` and
// `additionalProperties: false`, built once at module load in a fixed order (the order is part of
// the cached prefix). `calculate_payment` is deterministic; `propose_field_fill` only suggests,
// and the backend decides (server/copilot/turn.ts verifies the quote and the field).

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { fillableFields, TERM_MONTH_OPTIONS } from "@shared/application-schema";
import { PRODUCT_IDS, type ProductId } from "@shared/catalog-ids";

export const CALCULATE_PAYMENT = "calculate_payment";
export const PROPOSE_FIELD_FILL = "propose_field_fill";

/** The fields the copilot may propose, in schema order. */
export const FILLABLE_FIELD_IDS: readonly string[] = fillableFields().map((field) => field.id);

/** One phrase per product id for the tool description. A new product id fails to compile until it has one. */
const PRODUCT_PHRASES: Record<ProductId, string> = {
  fixed_10y: "Option A, the 10-year fixed-rate loan",
  zero_intro_18m: "Option B, the 0% introductory-period loan",
  deferred_12m: "Option C, the deferred-interest loan",
};

const TERM_VALUES = TERM_MONTH_OPTIONS.join(", ");
const PRODUCT_VALUES = PRODUCT_IDS.map((id) => `${id} (${PRODUCT_PHRASES[id]})`).join("; ");

const calculatePayment: Anthropic.Tool = {
  name: CALCULATE_PAYMENT,
  description:
    "Computes the monthly payment, total cost and required loan figures for the GoodLeap products, exactly. " +
    "Call this whenever the contractor asks what a payment would be, asks to compare options, or asks to see " +
    "the options for a project. Never work out a payment yourself. The application's requested loan amount " +
    "and preferred term take precedence over the arguments when the application already has them.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      amount_cents: {
        type: "integer",
        description:
          "The loan amount in whole cents, converted from the amount the contractor stated: $30K is 3000000, $42,500 is 4250000.",
      },
      term_months: {
        anyOf: [{ type: "integer" }, { type: "null" }],
        description:
          "The term in months only if the contractor named one (10 years is 120); otherwise null. A term applies to the fixed-rate product only.",
      },
      product_ids: {
        type: "array",
        items: { type: "string", enum: [...PRODUCT_IDS] },
        description: "The products to price: all three unless the contractor named one.",
      },
    },
    required: ["amount_cents", "term_months", "product_ids"],
    additionalProperties: false,
  },
};

const proposeFieldFill: Anthropic.Tool = {
  name: PROPOSE_FIELD_FILL,
  description:
    "Suggests a value for one application field from something the contractor stated as fact. The contractor " +
    "confirms or dismisses every suggestion. Use it only for declarative statements, never for questions, " +
    "conditionals or guesses, and quote the contractor's own words exactly as typed. " +
    "A term the contractor names (\"the 10-year option\", \"ten years\", \"120 months\") fills " +
    `preferred_term_months with its value in months, one of ${TERM_VALUES} (10 years is 120); make that call ` +
    "as well as the selected_product_id call when the same words also name a product. " +
    `selected_product_id takes one of: ${PRODUCT_VALUES}.`,
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      field: {
        type: "string",
        enum: [...FILLABLE_FIELD_IDS],
        description: "The application field to fill.",
      },
      value: {
        type: "string",
        description:
          "The value as the contractor stated it, as text: a dollar amount such as $30K, a project type, a name, a ZIP code. " +
          `For preferred_term_months, the months as digits (${TERM_VALUES}); for selected_product_id, the product id.`,
      },
      message_id: {
        type: "string",
        description: "The id of the contractor message that states it, written as m_12 without brackets.",
      },
      verbatim_quote: {
        type: "string",
        description: "The exact words from that message that state the value, copied character for character.",
      },
    },
    required: ["field", "value", "message_id", "verbatim_quote"],
    additionalProperties: false,
  },
};

/** The tools in their fixed order. */
export const TOOLS: Anthropic.Tool[] = [calculatePayment, proposeFieldFill];

// What the model's arguments must satisfy beyond the JSON schema, which strict mode already enforces.
export const CalculatePaymentArgsSchema = z.object({
  amount_cents: z.number().int().positive(),
  term_months: z.number().int().positive().nullable(),
  product_ids: z.array(z.enum(PRODUCT_IDS)),
});
export type CalculatePaymentArgs = z.infer<typeof CalculatePaymentArgsSchema>;

export const ProposeFieldFillArgsSchema = z.object({
  field: z.string().refine((id) => FILLABLE_FIELD_IDS.includes(id), "not a fillable field"),
  value: z.string().trim().min(1),
  message_id: z.string().trim().min(1),
  verbatim_quote: z.string().trim().min(1),
});
export type ProposeFieldFillArgs = z.infer<typeof ProposeFieldFillArgsSchema>;
