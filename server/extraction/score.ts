import { readFileSync } from "node:fs";
import {
  PAY_FREQUENCIES,
  fieldKeyFor,
  modelFields,
  schemaForSlot,
} from "@shared/document-schemas/index";
import { normalizeText } from "@shared/normalize";
import type { DocumentSlot, FieldValue, MatchMethod, ProposedValue } from "@shared/schemas";
import { annualize } from "../review/derived.js";
import { PROJECT_ROOT } from "../versions.js";

// The extraction eval: what the model returned for the sample documents against
// samples/ground_truth.json. Two numbers per document: how many fields hold the right value after
// parsing (field match) and how many of them were located on the page (a box can be drawn). The
// pay stub's net pay is not located by construction (its OCR words carry no geometry), so it is
// left out of the located rate.

/** Thresholds of the extraction set (Technical Plan section 12). */
export const THRESHOLDS = { text_pdf_field_match: 0.9, image_pdf_located: 0.8 } as const;

/** Fields whose position is missing from the committed OCR output on purpose. */
export const ENGINEERED_NOT_LOCATED: ReadonlySet<string> = new Set(["pay_stub.net_pay"]);

interface TruthEntry {
  value: string;
  cents?: number;
  iso?: string;
  normalized?: string;
  integer?: number;
  derived?: boolean;
}

export type GroundTruth = Record<DocumentSlot, Record<string, TruthEntry>>;

export function loadGroundTruth(path = `${PROJECT_ROOT}samples/ground_truth.json`): GroundTruth {
  return JSON.parse(readFileSync(path, "utf8")) as GroundTruth;
}

/** The stored form of a ground-truth value: cents, an ISO date, an enum value, a count, or text. */
export function expectedValue(entry: TruthEntry): FieldValue {
  return entry.cents ?? entry.iso ?? entry.normalized ?? entry.integer ?? entry.value;
}

export interface FieldScore {
  field_key: string;
  expected: FieldValue;
  actual: FieldValue | null;
  value_match: boolean;
  method: MatchMethod | null;
  located: boolean;
}

export interface DocumentScore {
  slot: DocumentSlot;
  fields: FieldScore[];
  /** Fields whose value equals the ground truth, and how many fields were scored. */
  matched: number;
  total: number;
  match_rate: number;
  /** Located fields among those that count toward the located rate. */
  located: number;
  located_total: number;
  located_rate: number;
  not_located: string[];
  not_extracted: string[];
  /** Annualized income computed from the extracted gross pay and pay frequency, against the ground truth. */
  derived: { field_key: string; expected: number; actual: number | null; value_match: boolean } | null;
}

function sameValue(actual: FieldValue | null, expected: FieldValue): boolean {
  if (actual === null) return false;
  if (typeof expected === "number" || typeof actual === "number") return actual === expected;
  return normalizeText(actual) === normalizeText(expected);
}

/** Scores one document's proposals (the newest per field key) against the ground truth. */
export function scoreDocument(
  slot: DocumentSlot,
  proposals: readonly ProposedValue[],
  truth: GroundTruth = loadGroundTruth(),
): DocumentScore {
  const byKey = new Map<string, ProposedValue>();
  for (const p of proposals) if (p.source.kind === "box") byKey.set(p.field_key, p);

  const fields: FieldScore[] = modelFields(schemaForSlot(slot)).map((field) => {
    const key = fieldKeyFor(slot, field.id);
    const entry = truth[slot][field.id];
    const proposal = byKey.get(key);
    const expected = entry ? expectedValue(entry) : "";
    const method = proposal?.match?.method ?? null;
    return {
      field_key: key,
      expected,
      actual: proposal?.value ?? null,
      value_match: sameValue(proposal?.value ?? null, expected),
      method,
      located: method === "exact" || method === "normalized",
    };
  });

  const counted = fields.filter((f) => !ENGINEERED_NOT_LOCATED.has(f.field_key));
  const matched = fields.filter((f) => f.value_match).length;
  const located = counted.filter((f) => f.located).length;

  let derived: DocumentScore["derived"] = null;
  const derivedField = schemaForSlot(slot).fields.find((f) => f.derived);
  const derivedTruth = derivedField ? truth[slot][derivedField.id] : undefined;
  if (derivedField && derivedTruth?.cents !== undefined) {
    const gross = byKey.get(fieldKeyFor(slot, "gross_pay"))?.value;
    const frequency = byKey.get(fieldKeyFor(slot, "pay_frequency"))?.value;
    const actual =
      typeof gross === "number" && (PAY_FREQUENCIES as readonly unknown[]).includes(frequency)
        ? annualize(gross, frequency as (typeof PAY_FREQUENCIES)[number])
        : null;
    derived = {
      field_key: fieldKeyFor(slot, derivedField.id),
      expected: derivedTruth.cents,
      actual,
      value_match: actual === derivedTruth.cents,
    };
  }

  return {
    slot,
    fields,
    matched,
    total: fields.length,
    match_rate: fields.length === 0 ? 0 : matched / fields.length,
    located,
    located_total: counted.length,
    located_rate: counted.length === 0 ? 0 : located / counted.length,
    not_located: fields.filter((f) => f.method === "not_located").map((f) => f.field_key),
    not_extracted: fields.filter((f) => f.method === "not_extracted" || f.actual === null).map((f) => f.field_key),
    derived,
  };
}
