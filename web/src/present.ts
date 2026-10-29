import { fieldDef } from "@shared/application-schema";
import { formatMoney } from "@shared/format";
import type {
  ApplicationFieldView,
  ApplicationView,
  AuditEvent,
  DisclosureBlock,
  FieldValue,
  OptionDisplay,
  PaymentOption,
  VersionsBlock,
} from "@shared/schemas";
import type { DisclosureOption } from "./types";

// Presenters: stored values as the words on the screen. The payment options are not formatted here:
// the server sends each option's payment, term and APR as text (`options_display`) and the page prints it.

// ---------------------------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------------------------

const ENUM_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  project_type: {
    roofing: "Roofing",
    solar: "Solar",
    hvac: "Heating and cooling",
    windows_doors: "Windows and doors",
    kitchen_bath: "Kitchen and bath",
    other: "Other",
  },
  preferred_term_months: {
    "60": "60 months",
    "120": "120 months",
    "180": "180 months",
    "240": "240 months",
  },
  selected_product_id: {
    fixed_10y: "10-year fixed",
    zero_intro_18m: "0% for 18 months",
    deferred_12m: "12 months deferred interest",
  },
  employment_status: {
    employed: "Employed",
    self_employed: "Self-employed",
    retired: "Retired",
    other: "Other",
  },
};

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The label for one value of an enum field. */
export function enumLabel(fieldId: string, value: string): string {
  return ENUM_LABELS[fieldId]?.[value] ?? humanize(value);
}

/** A stored value as a person reads it: dollars for money, a label for an enum. */
export function fieldDisplayValue(fieldId: string, value: FieldValue): string {
  const def = fieldDef(fieldId);
  if (def?.type === "money" && typeof value === "number") return formatMoney(value);
  if (def?.type === "enum") return enumLabel(fieldId, String(value));
  return String(value);
}

/** A stored value as the text an input starts with: dollars for money, the raw value otherwise. */
export function fieldInputText(fieldId: string, value: FieldValue): string {
  const def = fieldDef(fieldId);
  if (def?.type === "money" && typeof value === "number") return formatMoney(value);
  return String(value);
}

export type FieldBadge = "empty" | "typed" | "proposed" | "confirmed" | "edited";

export const BADGE_LABELS: Readonly<Record<FieldBadge, string>> = {
  empty: "Empty",
  typed: "Typed",
  proposed: "Proposed",
  confirmed: "Confirmed",
  edited: "Edited",
};

/** The one-line caption under a field's badge. */
export function badgeCaption(badge: FieldBadge, required: boolean): string {
  switch (badge) {
    case "empty":
      return required ? "Required" : "Optional";
    case "typed":
      return "Entered by you";
    case "proposed":
      return "Waiting for your confirmation";
    case "confirmed":
      return "Confirmed";
    case "edited":
      return "Suggested value, changed by you";
  }
}

export interface SubmitGate {
  pending: number;
  /** True when submitting is not possible right now. */
  blocked: boolean;
  /** Why the button is disabled, or null when it is enabled. */
  reason: string | null;
}

/** What else is going on in the page that makes the form's current copy unsafe to submit. */
export interface SubmitActivity {
  /** An assistant reply is still arriving; it may be about to propose values. */
  turnRunning?: boolean;
  /** A save is in flight or queued. */
  writing?: boolean;
  /** A reload of the application is outstanding, so the form may not show the server's latest proposals. */
  refreshing?: boolean;
  /** The submit request itself is running. */
  submitting?: boolean;
}

/** Whether the application can be submitted, and why not. */
export function submitGate(view: ApplicationView, activity: SubmitActivity = {}): SubmitGate {
  const pending = Object.values(view.fields).filter((field) => field.state === "proposed").length;
  if (view.status !== "draft") return { pending, blocked: true, reason: null };
  const reason =
    pending === 0 ? null : pending === 1 ? "1 proposed value needs confirmation" : `${pending} proposed values need confirmation`;
  const busy = Boolean(activity.turnRunning || activity.writing || activity.refreshing || activity.submitting);
  return { pending, blocked: pending > 0 || busy, reason };
}

/** True when the calculator button can run: the form holds a typed or confirmed loan amount. */
export function hasRequestedAmount(view: ApplicationView | null): boolean {
  const field = view?.fields.requested_loan_amount;
  if (!field) return false;
  return field.state !== "proposed" || field.previous !== null;
}

/** The id of the contractor message a field's value was proposed from, or null for any other source. */
export function proposalMessageId(field: ApplicationFieldView): string | null {
  return field.source_ref?.kind === "message" ? field.source_ref.ref.message_id : null;
}

/** The words the server verified in that message, or null when the source is not a message or the quote is blank. */
export function proposalQuote(field: ApplicationFieldView): string | null {
  if (field.source_ref?.kind !== "message") return null;
  const quote = field.source_ref.ref.quote;
  return quote.trim() === "" ? null : quote;
}

/** The file name shown on a document slot. */
export function documentName(fileRef: string): string {
  const parts = fileRef.split("/");
  return parts[parts.length - 1] ?? fileRef;
}

export const SLOT_LABELS = {
  pay_stub: "Pay stub",
  estimate: "Project estimate",
  scope_letter: "Scope letter",
} as const;

// ---------------------------------------------------------------------------------------------
// Payment options
// ---------------------------------------------------------------------------------------------

export function disclosureFor(block: DisclosureBlock, productId: string): DisclosureOption | null {
  return block.options.find((option) => option.product_id === productId) ?? null;
}

/** The server's display strings for one option, or null when the list has none for it. */
export function displayFor(display: readonly OptionDisplay[], productId: string): OptionDisplay | null {
  return display.find((entry) => entry.product_id === productId) ?? null;
}

/** True when every option has its display strings, so no row or card prints without its payment, term and APR. */
export function displayCovers(options: readonly PaymentOption[], display: readonly OptionDisplay[]): boolean {
  return options.every((option) => displayFor(display, option.product_id) !== null);
}

/** True when the disclosure block has an entry for every option, so no card can print without its TILA box. */
export function disclosureCovers(options: readonly PaymentOption[], block: DisclosureBlock): boolean {
  return options.every((option) => disclosureFor(block, option.product_id) !== null);
}

/** The options in the order the homeowner reads them: by term, ties keeping the server's order. */
export function orderByTerm(options: readonly PaymentOption[]): PaymentOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => a.option.term_months - b.option.term_months || a.index - b.index)
    .map(({ option }) => option);
}

export function proposalCountText(count: number): string {
  return count === 1 ? "1 value suggested on the form." : `${count} values suggested on the form.`;
}

// ---------------------------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function show(fieldKey: string, value: FieldValue | null): string {
  return value === null ? "no value" : fieldDisplayValue(fieldKey, value);
}

/** One line saying what an event recorded. */
export function summarizeEvent(event: AuditEvent): string {
  switch (event.type) {
    case "message.received":
      return `“${truncate(event.text, 140)}”`;
    case "model.call":
      return `${event.use_case} · ${event.model_id}${event.error_code ? ` · ${event.error_code}` : ""}`;
    case "tool.call":
      return `${event.service}.${event.method}`;
    case "guardrail.verdict":
      return `${event.layer}: ${event.verdict}${event.outcome === "pass" || event.outcome === "blocked" ? "" : ` (${event.outcome})`}`;
    case "field.proposed":
      return `${event.field_key} → ${show(event.field_key, event.value)}${event.dropped_reason ? ` (dropped: ${event.dropped_reason})` : ""}`;
    case "field.edited":
      return `${event.field_key}: ${show(event.field_key, event.before)} → ${show(event.field_key, event.after)}`;
    case "field.confirmed":
      return `${event.field_key} = ${show(event.field_key, event.final_value)} (${event.source})`;
    case "field.rejected":
      return `${event.field_key} (${event.reason_code})`;
    case "view.rendered":
      return `homeowner view for ${event.options_id}`;
    case "document.attached":
      return `${event.slot} (${event.adapter})`;
    case "extraction.completed":
      return `${event.document_id} · ${event.extraction_status}`;
    case "review.task_created":
      return `task ${event.task_id}`;
    case "review.started":
      return `task ${event.task_id}`;
    case "review.completed":
      return `task ${event.task_id} · ${event.open_discrepancies} open differences`;
    case "discrepancy.raised":
    case "discrepancy.sent":
    case "discrepancy.replied":
    case "discrepancy.resolved":
      return `${event.record.field_key} · ${event.record.status}`;
    case "application.state_changed":
      return `${event.from} → ${event.to}`;
    case "application.submitted":
      return `${event.document_ids.length} documents attached`;
    case "context.compacted":
      return `${event.dropped_message_ids.length} earlier messages left the model's context`;
    case "options.stored":
      return `${event.options_id} · ${event.product_ids.length} products`;
    case "options.explained":
      return event.options_id;
  }
}

/** MOCK for a mocked service call or a replayed fixture, LIVE for a real one; null for other events. */
export function eventBadge(event: AuditEvent): "MOCK" | "LIVE" | null {
  if (event.type === "tool.call") return event._mock ? "MOCK" : "LIVE";
  if (event.type === "model.call") return event._fixture ? "MOCK" : "LIVE";
  return null;
}

/** Token counts and latency of a model call, or null for any other event. */
export function usageText(event: AuditEvent): string | null {
  if (event.type !== "model.call") return null;
  const { input, output, cache_read } = event.usage;
  return `${input} in · ${output} out · ${cache_read} cached · ${Math.round(event.latency_ms)} ms`;
}

/** The versions block as label and value pairs, in the order it is stored. */
export function versionEntries(versions: VersionsBlock): Array<[string, string]> {
  return Object.entries(versions);
}

/** The short form of the versions block shown on a row: the git sha. */
export function versionSummary(versions: VersionsBlock): string {
  return `git ${versions.git_sha.slice(0, 7)}`;
}

/** A timestamp as the audit page shows it: date, time with milliseconds. */
export function formatTimestamp(ts: string, timeZone?: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}
