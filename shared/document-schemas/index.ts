import { parseMoney } from "../format.js";
import { normalizeText } from "../normalize.js";
import type { DiscrepancyReason } from "../reason-codes.js";
import type { DocumentSlot } from "../schemas.js";
import { ESTIMATE_SCHEMA } from "./estimate.js";
import { PAY_STUB_SCHEMA } from "./pay_stub.js";
import { SCOPE_LETTER_SCHEMA } from "./scope_letter.js";

// Declarative extraction schemas, one per document slot. The extraction prompt, the output schema,
// the value parser, the review task view and the discrepancy engine all read these definitions;
// nothing else names a document field. Document proposals use the key `<slot>.<field_id>`, so
// same-named fields in two documents never collide.

export type DocumentFieldType = "money" | "date" | "text" | "enum" | "integer";

/** How far a document value may sit from the application's value before a question is raised. */
export type Tolerance =
  /** Outside the stated value plus or minus the larger of `percent` of it and `absolute` cents. */
  | { kind: "percent_or_absolute"; percent: number; absolute: number }
  /** The stated value exceeds the extracted value by more than `percent` of the extracted value. */
  | { kind: "percent_over"; percent: number };

export interface DerivedFormula {
  /** Resolved to one named function in server/review/derived.ts. */
  formula: "annualized_income";
  /** Field ids of the same document whose final values are the formula's inputs. */
  inputs: readonly string[];
}

export interface DocumentFieldDef {
  id: string;
  label: string;
  type: DocumentFieldType;
  /** What the model should look for. */
  description: string;
  /** Allowed stored values of an `enum` field. */
  options?: readonly string[];
  /** The application field this value is compared to. */
  compareTo?: string;
  tolerance?: Tolerance;
  discrepancy_reason?: DiscrepancyReason;
  /** Present on a field the review path computes; the model is never asked for it. */
  derived?: DerivedFormula;
}

export interface DocumentSchema {
  slot: DocumentSlot;
  title: string;
  /** One line used for the slot-match check. */
  description: string;
  fields: readonly DocumentFieldDef[];
}

export const DOCUMENT_SCHEMAS: Readonly<Record<DocumentSlot, DocumentSchema>> = {
  pay_stub: PAY_STUB_SCHEMA,
  estimate: ESTIMATE_SCHEMA,
  scope_letter: SCOPE_LETTER_SCHEMA,
};

/** Slots in review order. */
export const DOCUMENT_SLOTS: readonly DocumentSlot[] = ["pay_stub", "estimate", "scope_letter"];

export function schemaForSlot(slot: DocumentSlot): DocumentSchema {
  return DOCUMENT_SCHEMAS[slot];
}

/** `pay_stub` + `gross_pay` -> `pay_stub.gross_pay`. */
export function fieldKeyFor(slot: DocumentSlot, fieldId: string): string {
  return `${slot}.${fieldId}`;
}

/** The schema field behind a `<slot>.<field_id>` key, with its slot; undefined for anything else. */
export function fieldForKey(
  fieldKey: string,
): { slot: DocumentSlot; schema: DocumentSchema; field: DocumentFieldDef } | undefined {
  const dot = fieldKey.indexOf(".");
  if (dot <= 0) return undefined;
  const slot = fieldKey.slice(0, dot) as DocumentSlot;
  const schema = DOCUMENT_SCHEMAS[slot];
  if (!schema) return undefined;
  const field = schema.fields.find((f) => f.id === fieldKey.slice(dot + 1));
  return field ? { slot, schema, field } : undefined;
}

/** The fields the model is asked for: everything except the derived ones. */
export function modelFields(schema: DocumentSchema): DocumentFieldDef[] {
  return schema.fields.filter((field) => field.derived === undefined);
}

// ---------------------------------------------------------------------------------------------
// Enum normalization
// ---------------------------------------------------------------------------------------------

export const PAY_FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly"] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

/** Pay periods in a year for each pay frequency. */
export const PERIODS_PER_YEAR: Readonly<Record<PayFrequency, number>> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

const PAY_FREQUENCY_SPELLINGS: Readonly<Record<PayFrequency, readonly string[]>> = {
  weekly: ["Weekly", "Every week", "Once a week", "Once per week", "52 pay periods"],
  biweekly: [
    "Biweekly",
    "Bi-Weekly",
    "Bi weekly",
    "Every two weeks",
    "Every 2 weeks",
    "Every other week",
    "Fortnightly",
    "26 pay periods",
  ],
  semimonthly: [
    "Semimonthly",
    "Semi-Monthly",
    "Semi monthly",
    "Twice a month",
    "Twice monthly",
    "Twice per month",
    "24 pay periods",
  ],
  monthly: ["Monthly", "Every month", "Once a month", "Once per month", "12 pay periods"],
};

/**
 * The enum normalization map: the normalized text of each spelling of a pay frequency (through
 * the project's one normalizer, so case, hyphens and punctuation do not matter) to its value.
 */
export const PAY_FREQUENCY_ALIASES: ReadonlyMap<string, PayFrequency> = new Map(
  PAY_FREQUENCIES.flatMap((value) =>
    PAY_FREQUENCY_SPELLINGS[value].map((spelling) => [normalizeText(spelling), value] as const),
  ),
);

function parseEnum(field: DocumentFieldDef, raw: string): string | null {
  const key = normalizeText(raw);
  if (field.id === "pay_frequency") return PAY_FREQUENCY_ALIASES.get(key) ?? null;
  return (field.options ?? []).find((option) => normalizeText(option) === key) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * A date as written to `YYYY-MM-DD`. Reads `MM/DD/YYYY`, `Month D, YYYY` (also `Mon D YYYY` and
 * `D Month YYYY`) and `YYYY-MM-DD`; null for anything else or a day that does not exist.
 */
export function parseDate(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) return isoDate(Number(match[3]), Number(match[1]), Number(match[2]));
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  const lower = text.toLowerCase().replace(/\./g, "");
  match = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(lower);
  if (match && MONTHS[match[1] ?? ""] !== undefined) {
    return isoDate(Number(match[3]), MONTHS[match[1] ?? ""] ?? 0, Number(match[2]));
  }
  match = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+),? (\d{4})$/.exec(lower);
  if (match && MONTHS[match[2] ?? ""] !== undefined) {
    return isoDate(Number(match[3]), MONTHS[match[2] ?? ""] ?? 0, Number(match[1]));
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------------------------

export type ParseResult = { ok: true; value: string | number } | { ok: false; error: string };

const fail = (error: string): ParseResult => ({ ok: false, error });

/**
 * Parses a value as written on the document into the stored form: money to integer cents, a date
 * to `YYYY-MM-DD`, an integer to a number, an enum to its value, text to trimmed text with single
 * spaces. A value that does not parse is an error and never a guess.
 */
export function parseAsWritten(field: DocumentFieldDef, raw: string): ParseResult {
  const text = raw.trim();
  if (text === "") return fail(`${field.label} is empty.`);
  switch (field.type) {
    case "money": {
      const cents = parseMoney(text);
      return cents === null ? fail(`${field.label} is not a dollar amount.`) : { ok: true, value: cents };
    }
    case "date": {
      const iso = parseDate(text);
      return iso === null ? fail(`${field.label} is not a date.`) : { ok: true, value: iso };
    }
    case "integer": {
      const digits = text.replace(/,/g, "");
      return /^\d+$/.test(digits) && Number.isSafeInteger(Number(digits))
        ? { ok: true, value: Number(digits) }
        : fail(`${field.label} is not a whole number.`);
    }
    case "enum": {
      const value = parseEnum(field, text);
      return value === null ? fail(`${field.label} is not a recognized value.`) : { ok: true, value };
    }
    case "text":
      return { ok: true, value: text.replace(/\s+/g, " ") };
  }
}

/**
 * Parses a value a reviewer typed when correcting a field. A string is read as written (a money
 * string is dollars); a number is the stored form already: integer cents for money, a whole
 * count for an integer field. Anything else is an error.
 */
export function parseCorrection(field: DocumentFieldDef, input: string | number): ParseResult {
  if (typeof input === "string") return parseAsWritten(field, input);
  if (!Number.isSafeInteger(input)) return fail(`${field.label} must be a whole number.`);
  if (field.type === "money") {
    return input > 0 ? { ok: true, value: input } : fail(`${field.label} must be more than zero.`);
  }
  if (field.type === "integer") {
    return input >= 0 ? { ok: true, value: input } : fail(`${field.label} must be zero or more.`);
  }
  return parseAsWritten(field, String(input));
}
