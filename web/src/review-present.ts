import type { DocumentFieldType } from "@shared/document-schemas/index";
import { formatMoney } from "@shared/format";
import type { Box, DiscrepancyRecord, DiscrepancyResolution, FieldValue, ReviewTask } from "@shared/schemas";
import type {
  ReviewDecision,
  RowLocation,
  RowStatus,
  TaskDocumentView,
  TaskFieldRow,
  TaskView,
} from "./review-types";

// The reviewer screen's pure parts: where a box lands on the rendered page, how rows are grouped,
// which controls are enabled and how a value reads. Nothing here computes a value: figures come from
// the server's rows and records, and these functions only place and word them.

// ---------------------------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------------------------

export interface PageSize {
  width: number;
  height: number;
}

export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A box in page-relative fractions (top-left origin) as pixels on a page rendered at `size`. */
export function boxToPixels(box: Box, size: PageSize): PixelBox {
  return {
    left: box.x * size.width,
    top: box.y * size.height,
    width: Math.max(0, box.w * size.width),
    height: Math.max(0, box.h * size.height),
  };
}

export interface RowBox {
  field_key: string;
  page: number;
  bbox: Box;
}

/**
 * The box the server sent for a row, or null. Only a located value has one, and only when the
 * server named both the page and the box; a value that was not located, not found or calculated
 * never gets a box.
 */
export function rowBox(row: TaskFieldRow, documentId: string): RowBox | null {
  if (row.location !== "located") return null;
  const source = row.proposal?.source;
  if (!source || source.kind !== "box") return null;
  const { bbox, page, document_id } = source.ref;
  if (bbox === null || page === null || document_id !== documentId) return null;
  return { field_key: row.field_key, page, bbox };
}

/** The boxes to draw on one page of a document, in row order. */
export function boxesOnPage(document: TaskDocumentView, page: number): RowBox[] {
  return document.rows.flatMap((row) => {
    const box = rowBox(row, document.id);
    return box && box.page === page ? [box] : [];
  });
}

export interface SourceClaim {
  /** The page the model cited, or null when it cited none. */
  page: number | null;
  quote: string;
}

/** What the model quoted and the page it claimed, for a value read from a document. */
export function sourceClaim(row: TaskFieldRow): SourceClaim | null {
  const source = row.proposal?.source;
  if (!source || source.kind !== "box") return null;
  return { page: source.ref.page, quote: source.ref.quoted_text };
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export interface RowGroup {
  id: "read" | "calculated";
  /** Null when the document has only one group, so the list needs no heading. */
  title: string | null;
  rows: TaskFieldRow[];
}

/** Rows in schema order, split into the values read from the document and the calculated ones. */
export function groupRows(rows: readonly TaskFieldRow[]): RowGroup[] {
  const read = rows.filter((row) => row.formula === null);
  const calculated = rows.filter((row) => row.formula !== null);
  const both = read.length > 0 && calculated.length > 0;
  const groups: RowGroup[] = [];
  if (read.length > 0) groups.push({ id: "read", title: both ? "Read from the document" : null, rows: read });
  if (calculated.length > 0) groups.push({ id: "calculated", title: both ? "Calculated" : null, rows: calculated });
  return groups;
}

export function countToDecide(rows: readonly TaskFieldRow[]): number {
  return rows.filter((row) => row.status === "undecided").length;
}

/** The key to select when a document opens: its first value to decide, else its first row. */
export function firstSelectable(document: TaskDocumentView): string | null {
  const first = document.rows.find((row) => row.status === "undecided") ?? document.rows[0];
  return first?.field_key ?? null;
}

/** The next value to decide after `afterKey`, wrapping to the start; null when none is left. */
export function nextUndecidedKey(rows: readonly TaskFieldRow[], afterKey: string): string | null {
  const start = rows.findIndex((row) => row.field_key === afterKey);
  const order = start < 0 ? rows : [...rows.slice(start + 1), ...rows.slice(0, start)];
  return order.find((row) => row.status === "undecided")?.field_key ?? null;
}

/** The page the viewer should show for a row: the located page, or the page the model claimed. */
export function rowPage(row: TaskFieldRow): number | null {
  return sourceClaim(row)?.page ?? null;
}

/** What a tab says under the document's name. */
export function tabCaption(document: TaskDocumentView): string {
  if (document.flag) return document.flag.kind === "wrong_document_type" ? "Wrong document" : "Read on the page";
  const left = countToDecide(document.rows);
  return left === 0 ? "All decided" : `${left} to decide`;
}

// ---------------------------------------------------------------------------------------------
// What the reviewer may do
// ---------------------------------------------------------------------------------------------

export function hasAction(row: TaskFieldRow, action: ReviewDecision["action"]): boolean {
  return row.actions.includes(action);
}

/** Confirm is offered with a value, and a value that was not located also needs the acknowledgement. */
export function canConfirm(row: TaskFieldRow, acknowledged: boolean): boolean {
  return hasAction(row, "confirm") && (!row.requires_acknowledgement || acknowledged);
}

export function canCorrect(row: TaskFieldRow, text: string): boolean {
  return hasAction(row, "correct") && text.trim() !== "";
}

/** The reason a flag starts with: a value that was never found is "missing", any other starts unchosen. */
export function defaultFlagReason(row: TaskFieldRow): string {
  return row.location === "not_extracted" ? "missing" : "";
}

export function canFlag(row: TaskFieldRow, reason: string): boolean {
  return hasAction(row, "flag") && reason !== "";
}

/** The request for a confirm: a value that was not located carries the reviewer's acknowledgement. */
export function confirmRequest(row: TaskFieldRow): ReviewDecision {
  return row.requires_acknowledgement ? { action: "confirm", located_by_reviewer: true } : { action: "confirm" };
}

export interface CompleteState {
  enabled: boolean;
  caption: string;
}

/**
 * Whether "Complete review" is available: the server allows it and no value in any document still
 * waits for a decision.
 */
export function completeState(view: TaskView): CompleteState {
  if (view.task.status === "complete") return { enabled: false, caption: "Review complete." };
  const rows = view.documents.flatMap((document) => document.rows);
  const toDecide = Math.max(view.undecided_count, rows.filter((row) => row.status === "undecided").length);
  if (toDecide > 0) {
    return {
      enabled: false,
      caption: toDecide === 1 ? "1 value still needs a decision." : `${toDecide} values still need a decision.`,
    };
  }
  if (rows.some((row) => row.status === "waiting")) {
    return { enabled: false, caption: "A calculated value is still waiting for its inputs." };
  }
  if (!view.can_complete) return { enabled: false, caption: "This review cannot be completed yet." };
  return { enabled: true, caption: "Every value has a decision." };
}

/** Open differences that are not resolved yet. */
export function openDiscrepancyCount(view: TaskView): number {
  return view.discrepancies.filter((item) => item.record.status === "open").length;
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

export const STATUS_LABELS: Readonly<Record<RowStatus, string>> = {
  undecided: "To decide",
  confirmed: "Confirmed",
  edited: "Corrected",
  flagged: "Flagged",
  waiting: "Waiting",
};

export const LOCATION_LABELS: Readonly<Record<RowLocation, string>> = {
  located: "Located",
  not_located: "Not located",
  not_extracted: "Not found",
  derived: "Calculated",
};

export const TASK_STATUS_LABELS: Readonly<Record<ReviewTask["status"], string>> = {
  ready: "Ready for review",
  in_review: "In review",
  complete: "Complete",
  extraction_failed: "Extraction failed",
};

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function formatDate(stored: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stored);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[3])}, ${match[1]}` : stored;
}

/** The label of one value of an enum field. */
export function enumOptionLabel(option: string): string {
  return humanize(option);
}

/** A stored value as the reviewer reads it: dollars for money cents, words for an enum, a date spelled out. */
export function formatRowValue(type: DocumentFieldType, value: FieldValue | null): string {
  if (value === null) return "";
  switch (type) {
    case "money":
      return typeof value === "number" && Number.isSafeInteger(value) ? formatMoney(value) : String(value);
    case "date":
      return formatDate(String(value));
    case "enum":
      return enumOptionLabel(String(value));
    default:
      return String(value);
  }
}

/** The text a correction starts with: what the server parses back into the same stored value. */
export function correctionStartText(type: DocumentFieldType, value: FieldValue | null): string {
  if (value === null) return "";
  if (type === "money" && typeof value === "number" && Number.isSafeInteger(value)) return formatMoney(value);
  return String(value);
}

/** The labels of the inputs a calculated value still waits for. */
export function waitingFor(row: TaskFieldRow): string[] {
  return (row.formula?.inputs ?? [])
    .filter((input) => input.state === null || input.state === "proposed")
    .map((input) => input.label);
}

/** One line saying what was decided on a row, or null while it waits. */
export function decisionSummary(row: TaskFieldRow, reasonLabels: Readonly<Record<string, string>>): string | null {
  switch (row.status) {
    case "confirmed":
      if (row.formula) return "Calculated from the confirmed values.";
      return row.decision?.located_by_reviewer ? "Confirmed. You found it on the page." : "Confirmed.";
    case "edited": {
      const before = row.decision?.before;
      const was = before === undefined || before === null ? "no value" : formatRowValue(row.type, before);
      return `Corrected from ${was}.`;
    }
    case "flagged": {
      const code = row.decision?.reason_code ?? row.proposal?.reason_code;
      const reason = code ? (reasonLabels[code] ?? humanize(code)) : "No reason given";
      const note = row.decision?.note?.trim();
      return note ? `Flagged: ${reason}. ${note}` : `Flagged: ${reason}.`;
    }
    default:
      return null;
  }
}

/** A when-line for the lists: "Oct 28, 10:42 AM". */
export function formatWhen(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

// ---------------------------------------------------------------------------------------------
// Differences
// ---------------------------------------------------------------------------------------------

/** One side of a difference: dollars for cents, the text itself otherwise. */
export function formatDiscrepancyValue(value: FieldValue | null): string {
  if (value === null) return "No value";
  return typeof value === "number" && Number.isSafeInteger(value) ? formatMoney(value) : String(value);
}

/** The difference the record stored, as dollars and the percent of the application's value. */
export function formatDifference(difference: DiscrepancyRecord["difference"]): string {
  const percent = String(Number(difference.percent.toFixed(2)));
  return `${formatMoney(difference.absolute)} (${percent}% of the application value)`;
}

export const RESOLUTION_LABELS: Readonly<Record<DiscrepancyResolution, string>> = {
  explained: "Explained",
  corrected: "Corrected",
};

export const RESOLUTION_HINTS: Readonly<Record<DiscrepancyResolution, string>> = {
  explained: "The reply accounts for the difference. Both values stand; the note says why.",
  corrected: "The reply gave a corrected figure. Record the figure in the note.",
};

/** Where a record is: waiting to be sent, waiting for a reply, answered or resolved. */
export function discrepancyStage(record: DiscrepancyRecord): "draft" | "sent" | "replied" | "resolved" {
  if (record.status === "resolved") return "resolved";
  if (record.sent_at === undefined) return "draft";
  return record.contractor_reply === undefined ? "sent" : "replied";
}

/** True while a sent question has no reply yet (the screen looks for it again on its own). */
export function awaitsReply(view: TaskView): boolean {
  return view.discrepancies.some((item) => discrepancyStage(item.record) === "sent");
}

/**
 * The row and document a record points at: the row holding the proposal it compared, else the row
 * for the same field (a calculated value that was recomputed since has a newer proposal).
 */
export function findRowForRecord(
  view: TaskView,
  record: DiscrepancyRecord,
): { document: TaskDocumentView; row: TaskFieldRow } | null {
  for (const document of view.documents) {
    const row = document.rows.find((candidate) => candidate.proposal?.id === record.extracted.proposal_id);
    if (row) return { document, row };
  }
  for (const document of view.documents) {
    const row = document.rows.find((candidate) => candidate.field_key === record.field_key);
    if (row) return { document, row };
  }
  return null;
}

export function reviewTaskPath(taskId: string): string {
  return `/reviewer/${encodeURIComponent(taskId)}`;
}
