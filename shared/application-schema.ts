import { z } from "zod";
import { PRODUCT_IDS } from "./catalog-ids.js";
import { parseMoney } from "./format.js";

// The application's fields as data: the form renders from this array, the propose_field_fill tool
// is generated from the fillable subset, and submit validates the required ones.

export type ApplicationFieldType = "text" | "money" | "integer" | "enum" | "zip";

export interface ApplicationFieldDef {
  id: string;
  label: string;
  type: ApplicationFieldType;
  /** Allowed values for `enum` fields. Enum values are stored as strings. */
  options?: readonly string[];
  required: boolean;
  /** The copilot may propose this field from a contractor's statement. */
  copilotFillable: boolean;
  /** The existing credit decision engine reads this field; the copilot never fills it. */
  decisionEngineInput: boolean;
}

export const PROJECT_TYPES = [
  "roofing",
  "solar",
  "hvac",
  "windows_doors",
  "kitchen_bath",
  "other",
] as const;

export const TERM_MONTH_OPTIONS = ["60", "120", "180", "240", "300"] as const;

export const EMPLOYMENT_STATUSES = ["employed", "self_employed", "retired", "other"] as const;

export const APPLICATION_FIELDS: readonly ApplicationFieldDef[] = [
  {
    id: "project_type",
    label: "Project type",
    type: "enum",
    options: PROJECT_TYPES,
    required: true,
    copilotFillable: true,
    decisionEngineInput: false,
  },
  {
    id: "project_description",
    label: "Project description",
    type: "text",
    required: false,
    copilotFillable: true,
    decisionEngineInput: false,
  },
  {
    id: "project_amount",
    label: "Project amount",
    type: "money",
    required: true,
    copilotFillable: true,
    decisionEngineInput: false,
  },
  {
    id: "requested_loan_amount",
    label: "Requested loan amount",
    type: "money",
    required: true,
    copilotFillable: true,
    decisionEngineInput: false,
  },
  {
    id: "preferred_term_months",
    label: "Preferred term (months)",
    type: "enum",
    options: TERM_MONTH_OPTIONS,
    required: false,
    copilotFillable: true,
    decisionEngineInput: false,
  },
  {
    id: "selected_product_id",
    label: "Selected product",
    type: "enum",
    options: PRODUCT_IDS,
    required: false,
    copilotFillable: true,
    decisionEngineInput: false,
  },
  {
    id: "homeowner_first_name",
    label: "Homeowner first name",
    type: "text",
    required: true,
    copilotFillable: true,
    decisionEngineInput: false,
  },
  {
    id: "homeowner_last_name",
    label: "Homeowner last name",
    type: "text",
    required: true,
    copilotFillable: true,
    decisionEngineInput: false,
  },
  {
    id: "property_zip",
    label: "Property ZIP code",
    type: "zip",
    required: true,
    copilotFillable: true,
    decisionEngineInput: false,
  },
  {
    id: "stated_annual_income",
    label: "Stated annual income",
    type: "money",
    required: true,
    copilotFillable: false,
    decisionEngineInput: true,
  },
  {
    id: "employer_name",
    label: "Employer name",
    type: "text",
    required: false,
    copilotFillable: false,
    decisionEngineInput: true,
  },
  {
    id: "employment_status",
    label: "Employment status",
    type: "enum",
    options: EMPLOYMENT_STATUSES,
    required: false,
    copilotFillable: false,
    decisionEngineInput: true,
  },
];

const FIELDS_BY_ID = new Map(APPLICATION_FIELDS.map((field) => [field.id, field]));

export function fieldDef(id: string): ApplicationFieldDef | undefined {
  return FIELDS_BY_ID.get(id);
}

export function isApplicationField(id: string): boolean {
  return FIELDS_BY_ID.has(id);
}

export function fillableFields(): ApplicationFieldDef[] {
  return APPLICATION_FIELDS.filter((field) => field.copilotFillable);
}

export function requiredFields(): ApplicationFieldDef[] {
  return APPLICATION_FIELDS.filter((field) => field.required);
}

const ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

function requireDef(id: string): ApplicationFieldDef {
  const def = FIELDS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown application field: ${id}`);
  return def;
}

function enumSchema(def: ApplicationFieldDef): z.ZodType<string> {
  const options = def.options ?? [];
  return z.enum(options as [string, ...string[]]);
}

/**
 * Parses a string typed by a person (or proposed by the copilot) into the field's stored value:
 * money strings such as "$30K", "30,000" and "30000.00" become integer cents; enum values match
 * case-insensitively with spaces and hyphens read as underscores; text is trimmed and non-empty;
 * a ZIP code is five digits, optionally with a four-digit extension.
 */
export function zodForField(id: string): z.ZodType<string | number, z.ZodTypeDef, string> {
  const def = requireDef(id);
  const base = z.string().trim().min(1, `Enter a value for ${def.label.toLowerCase()}.`);
  switch (def.type) {
    case "text":
      return base;
    case "money":
      return base.transform((text, ctx) => {
        const cents = parseMoney(text);
        if (cents === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Enter ${def.label.toLowerCase()} as a dollar amount, such as $30,000.`,
          });
          return z.NEVER;
        }
        return cents;
      });
    case "integer":
      return base.transform((text, ctx) => {
        if (!/^\d+$/.test(text)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Enter ${def.label.toLowerCase()} as a whole number.`,
          });
          return z.NEVER;
        }
        return Number(text);
      });
    case "zip":
      return base.refine((text) => ZIP_PATTERN.test(text), {
        message: "Enter a five-digit ZIP code.",
      });
    case "enum": {
      const options = def.options ?? [];
      return base.transform((text, ctx) => {
        const wanted = text.toLowerCase().replace(/[\s-]+/g, "_");
        const found = options.find((option) => option.toLowerCase() === wanted);
        if (found === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${def.label} must be one of: ${options.join(", ")}.`,
          });
          return z.NEVER;
        }
        return found;
      });
    }
  }
}

/**
 * Validates an already-typed stored value: integer cents for money, a member of the options for
 * an enum, a non-empty string for text and ZIP. Commands check values with this schema.
 */
export function valueSchemaForField(id: string): z.ZodType<string | number> {
  const def = requireDef(id);
  switch (def.type) {
    case "text":
      return z.string().trim().min(1);
    case "money":
      return z.number().int().positive();
    case "integer":
      return z.number().int().nonnegative();
    case "zip":
      return z.string().regex(ZIP_PATTERN);
    case "enum":
      return enumSchema(def);
  }
}
