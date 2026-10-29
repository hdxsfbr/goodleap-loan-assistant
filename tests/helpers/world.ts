import { schemaForSlot } from "@shared/document-schemas/index";
import type { DocumentAdapter, DocumentRecord, DocumentSlot } from "@shared/schemas";
import { createAuditLog, createMemorySink, installAuditLog, type Ctx, type MemorySink } from "../../server/audit-log.js";
import { attachDocument, setFieldValue, submitApplication } from "../../server/commands.js";
import type { ModelCaller } from "../../server/extraction/llm.js";
import { store } from "../../server/store.js";

// Shared setup for the extraction and review tests: a fresh store with the seeded application, a
// memory audit log, and a submitted application with the three sample documents attached.

export const APP = "app_demo_001";

export const contractor: Ctx = {
  application_id: APP,
  session_id: "test-session",
  actor: { type: "contractor", id: "ctr_demo_001" },
};
export const reviewer: Ctx = { ...contractor, actor: { type: "reviewer", id: "rev_demo_001" } };
export const system: Ctx = { ...contractor, actor: { type: "system", id: "system" } };

const SAMPLES: Record<DocumentSlot, { file: string; adapter: DocumentAdapter }> = {
  pay_stub: { file: "samples/paystub.pdf", adapter: "ocr_fixture" },
  estimate: { file: "samples/estimate.pdf", adapter: "pdfjs" },
  scope_letter: { file: "samples/scope_letter.pdf", adapter: "pdfjs" },
};

export interface World {
  sink: MemorySink;
  docs: Partial<Record<DocumentSlot, DocumentRecord>>;
}

export interface WorldOptions {
  slots?: DocumentSlot[];
  /** Stated annual income on the application, in cents. */
  stated_income?: number;
  /** Requested loan amount on the application, in cents. */
  requested?: number;
  /** Leave the application as a draft (documents attached, not submitted). */
  submit?: boolean;
}

/** Resets the store and the audit log and returns an application with its documents, submitted. */
export function freshWorld(options: WorldOptions = {}): World {
  store.reset();
  store.loadSeed();
  const sink = createMemorySink();
  installAuditLog(createAuditLog(sink));
  const values: Array<[string, string | number]> = [
    ["project_type", "roofing"],
    ["project_amount", 3_000_000],
    ["requested_loan_amount", options.requested ?? 3_000_000],
    ["homeowner_first_name", "Maria"],
    ["homeowner_last_name", "Lopez"],
    ["property_zip", "95112"],
    ["stated_annual_income", options.stated_income ?? 8_500_000],
  ];
  for (const [key, value] of values) setFieldValue(contractor, key, value);
  const docs: World["docs"] = {};
  for (const slot of options.slots ?? (["pay_stub", "estimate", "scope_letter"] as const)) {
    const sample = SAMPLES[slot];
    docs[slot] = attachDocument(contractor, slot, sample.file, sample.adapter).document;
  }
  if (options.submit !== false) submitApplication(contractor);
  return { sink, docs };
}

interface PickedSpan {
  value: string;
  page?: number;
  line: number;
  start: number;
  end: number;
  quote?: string;
}

function selectionOf(span: PickedSpan | null) {
  if (!span) return null;
  return {
    value: span.value,
    page: span.page ?? 1,
    line: span.line,
    token_start: span.start,
    token_end: span.end,
    quoted_text: span.quote ?? span.value,
  };
}

/**
 * What a careful model returns for each sample document, written by hand from the indexed lines
 * the prompt shows (see the lines printed by `toIndexedLines`). Used to drive the pipeline
 * without a key; the recorded fixture covers the real model's answers.
 */
export const GOOD_SPANS: Record<DocumentSlot, Record<string, PickedSpan | null>> = {
  pay_stub: {
    employer_name: { value: "Pinecrest Harbor Logistics", line: 0, start: 0, end: 2 },
    pay_period_start: { value: "10/05/2026", line: 4, start: 3, end: 3 },
    pay_period_end: { value: "10/18/2026", line: 5, start: 3, end: 3 },
    pay_frequency: { value: "Biweekly", line: 3, start: 2, end: 2 },
    gross_pay: { value: "2,350.00", line: 7, start: 2, end: 2 },
    net_pay: { value: "1,812.40", line: 12, start: 2, end: 2 },
    ytd_gross: { value: "49,350.00", line: 13, start: 2, end: 2 },
  },
  estimate: {
    contractor_name: { value: "Calderbrook Roofing", line: 0, start: 0, end: 1 },
    project_description: {
      value: "Full roof replacement with architectural composition shingles",
      line: 6,
      start: 1,
      end: 7,
    },
    estimate_date: { value: "September 14, 2026", line: 3, start: 2, end: 4 },
    total_amount: { value: "$31,000.00", line: 13, start: 2, end: 2 },
    line_item_count: { value: "4", line: 12, start: 2, end: 2 },
  },
  scope_letter: {
    property_address: {
      value: "2217 Marlow Court, San Jose, CA 95112",
      line: 9,
      start: 2,
      end: 8,
    },
    scope_summary: {
      value: "Complete tear-off and re-roof with architectural shingles",
      line: 10,
      start: 3,
      end: 9,
    },
    start_date: { value: "November 9, 2026", line: 11, start: 3, end: 5 },
    contractor_name: { value: "Calderbrook Roofing", line: 0, start: 0, end: 1 },
  },
};

/** The JSON text of a model answer for a slot, with `overrides` replacing individual fields. */
export function answerFor(
  slot: DocumentSlot,
  overrides: Record<string, PickedSpan | null | ReturnType<typeof selectionOf>> = {},
  matches = true,
): string {
  const fields: Record<string, unknown> = {};
  for (const [id, span] of Object.entries(GOOD_SPANS[slot])) fields[id] = selectionOf(span);
  for (const [id, value] of Object.entries(overrides)) {
    fields[id] = value === null || "line" in (value as object) ? selectionOf(value as PickedSpan | null) : value;
  }
  return JSON.stringify({ document_matches_slot: matches, fields });
}

/** A caller that answers each call with the next text in `texts` (the last one repeats). */
export function scriptedCaller(texts: Array<string | Error>, calls?: { count: number }): ModelCaller {
  let i = 0;
  return async () => {
    if (calls) calls.count += 1;
    const next = texts[Math.min(i, texts.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return { event_id: "evt_scripted", model_id: "scripted-model", text: next ?? "", stop_reason: "end_turn" };
  };
}

/**
 * A caller that answers each sample document with its good answer, found by the document title in
 * the prompt. `answers` replaces the answer text of a slot.
 */
export function goodCaller(answers: Partial<Record<DocumentSlot, string | Error>> = {}): ModelCaller {
  return async (_ctx, request) => {
    const slot = (Object.keys(GOOD_SPANS) as DocumentSlot[]).find((s) =>
      request.user.startsWith(`Expected document: ${schemaForSlot(s).title}.`),
    );
    if (!slot) throw new Error("The prompt does not name a known document.");
    const answer = answers[slot] ?? answerFor(slot);
    if (answer instanceof Error) throw answer;
    return { event_id: "evt_scripted", model_id: "scripted-model", text: answer, stop_reason: "end_turn" };
  };
}
