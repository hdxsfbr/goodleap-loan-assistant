import {
  fieldDef,
  isApplicationField,
  requiredFields,
  valueSchemaForField,
} from "@shared/application-schema";
import { normalizeText } from "@shared/normalize";
import {
  ContractorRejectReasonSchema,
  DiscrepancyReasonSchema,
  FlagReasonSchema,
  RejectReasonSchema,
  type RejectReason,
} from "@shared/reason-codes";
import {
  DiscrepancyRaiseInputSchema,
  DiscrepancyResolutionSchema,
  DocumentAdapterSchema,
  DocumentSlotSchema,
  ExtractionStatusSchema,
  MatchResultSchema,
  OptionsRecordSchema,
  ProposalSourceSchema,
  VerifiedIncomeSchema,
  type Application,
  type ApplicationStatus,
  type DiscrepancyRaiseInput,
  type DiscrepancyRecord,
  type DiscrepancyResolution,
  type DocumentAdapter,
  type DocumentRecord,
  type DocumentSlot,
  type DroppedReason,
  type ErrorCode,
  type ExtractionStatus,
  type FieldValue,
  type MatchResult,
  type OptionsRecord,
  type ProposalSource,
  type ProposedValue,
  type ReviewTask,
  type TranscriptMessage,
} from "@shared/schemas";
import type { z } from "zod";
import { audit, auditInput, type AuditEventInput, type Ctx } from "./audit-log.js";
import { deriveBanner } from "./domain/banner.js";
import { CommandError } from "./errors.js";
import { nextId, slotOfFieldKey, store, storeWriter } from "./store.js";

// The only write path. Every command takes `ctx`, validates the transition against the invariants
// of Technical Plan section 3, appends its primary audit event (and, when the application status
// changes, one `application.state_changed`, in the same batch), and only then mutates the store, so
// an event that fails validation leaves no state behind. Commands are pure transitions: none calls the
// discrepancy engine, the extraction queue, a service or any module above the store.

export type { Ctx } from "./audit-log.js";

const nowIso = (): string => new Date().toISOString();

/** Drops undefined values so optional audit fields are absent rather than present-and-undefined. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const copy = <T>(value: T): T => structuredClone(value);

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------

function requireApplication(ctx: Ctx): Application {
  const app = storeWriter().applications.get(ctx.application_id);
  if (!app) {
    throw new CommandError(`Application ${ctx.application_id} was not found.`, { status: 404 });
  }
  return app;
}

function requireDraft(app: Application, action: string): void {
  if (app.status !== "draft") {
    throw new CommandError(`${action} after the application has been submitted.`);
  }
}

function requireLiveProposal(ctx: Ctx, proposalId: string): ProposedValue {
  const proposal = storeWriter().proposals.get(proposalId);
  if (
    !proposal ||
    proposal.application_id !== ctx.application_id ||
    proposal.state !== "proposed"
  ) {
    throw new CommandError("That suggestion is no longer waiting for a decision.", {
      details: { proposal_id: proposalId },
    });
  }
  return proposal;
}

function requireOpenTask(ctx: Ctx, taskId: string): ReviewTask {
  const task = storeWriter().reviewTasks.get(taskId);
  if (!task || task.application_id !== ctx.application_id) {
    throw new CommandError(`Review task ${taskId} was not found.`, { status: 404 });
  }
  if (task.status === "complete") {
    throw new CommandError("This review is already complete.");
  }
  return task;
}

function requireDiscrepancy(ctx: Ctx, recordId: string): DiscrepancyRecord {
  const record = storeWriter().discrepancies.get(recordId);
  if (!record || record.application_id !== ctx.application_id) {
    throw new CommandError(`Discrepancy ${recordId} was not found.`, { status: 404 });
  }
  return record;
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, message: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CommandError(message, { status: 400 });
  return parsed.data;
}

function sameValue(a: FieldValue, b: FieldValue | null): boolean {
  return b !== null && normalizeText(String(a)) === normalizeText(String(b));
}

/**
 * The `application.state_changed` event for moving `app` to `to`. The caller appends it in the
 * same batch as the event that causes the change, then sets `app.status`.
 */
function stateChangedInput(ctx: Ctx, app: Application, to: ApplicationStatus): AuditEventInput {
  const banner = deriveBanner(store.listDiscrepancies(app.id));
  return auditInput(ctx, "application.state_changed", {
    from: app.status,
    to,
    derived_banner: banner?.text ?? null,
  });
}

// ---------------------------------------------------------------------------------------------
// Form values
// ---------------------------------------------------------------------------------------------

/**
 * Stores a contractor-typed value as state `typed` (which counts as confirmed everywhere a
 * confirmed value is read) and emits `field.confirmed` with `source: "typed"`.
 */
export function setFieldValue(
  ctx: Ctx,
  field_key: string,
  value: FieldValue,
): { event_id: string } {
  const app = requireApplication(ctx);
  requireDraft(app, "Fields can't be changed");
  const def = fieldDef(field_key);
  if (!def) throw new CommandError(`${field_key} is not an application field.`, { status: 400 });
  const typed = parseOrThrow(
    valueSchemaForField(field_key),
    value,
    `Enter a valid value for ${def.label.toLowerCase()}.`,
  );
  const event = audit.emit(ctx, "field.confirmed", {
    proposal_id: null,
    field_key,
    source: "typed",
    final_value: typed,
  });
  app.fields[field_key] = { value: typed, state: "typed", source_ref: null };
  return { event_id: event.event_id };
}

// ---------------------------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------------------------

export interface ProposeInput {
  /** An application field id, or `<slot>.<field_id>` for a document value. */
  field_key: string;
  /** Null only for a document field the model did not find. */
  value: FieldValue | null;
  source: ProposalSource;
  match?: MatchResult;
}

export interface ProposeResult {
  /** Null when the value was dropped. */
  proposal: ProposedValue | null;
  dropped_reason?: DroppedReason;
  superseded: string[];
  event_id: string;
}

function checkSourceExists(ctx: Ctx, source: ProposalSource): void {
  const state = storeWriter();
  if (source.kind === "message") {
    const known = (state.messages.get(ctx.application_id) ?? []).some(
      (m) => m.id === source.ref.message_id,
    );
    if (!known) throw new CommandError("That suggestion points at a message that does not exist.");
  } else if (source.kind === "box") {
    const doc = state.documents.get(source.ref.document_id);
    if (!doc || doc.application_id !== ctx.application_id) {
      throw new CommandError("That suggestion points at a document that does not exist.");
    }
  } else {
    for (const input of source.ref.inputs) {
      const proposal = state.proposals.get(input);
      if (!proposal || proposal.application_id !== ctx.application_id) {
        throw new CommandError("That calculated value points at an input that does not exist.");
      }
    }
  }
}

/** `<slot>.<field_id>` split at the first dot: the document slot, when the key has that form. */
function documentSlotOfKey(field_key: string): DocumentSlot | undefined {
  const slot = slotOfFieldKey(field_key);
  if (slot === undefined || field_key.length === slot.length + 1) return undefined;
  const parsed = DocumentSlotSchema.safeParse(slot);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The domains of key and source. A message source fills an application field, so a slot-qualified
 * key is wrong for it. A box or formula source fills `<slot>.<field_id>`, so an application field
 * key is wrong for it, and the slot must be the slot of the document the box points at, or of every
 * proposal the formula derives from. The field id is not checked against a document schema.
 * The source has already been checked to exist.
 */
function requireKeyMatchesSource(field_key: string, source: ProposalSource): void {
  if (source.kind === "message") {
    if (slotOfFieldKey(field_key) !== undefined) {
      throw new CommandError(`${field_key} is a document field; a chat message can only fill the form.`, {
        status: 400,
      });
    }
    return;
  }
  const slot = documentSlotOfKey(field_key);
  if (slot === undefined) {
    throw new CommandError(`${field_key} is not a document field; a document value needs a key like pay_stub.gross_pay.`, {
      status: 400,
    });
  }
  const state = storeWriter();
  if (source.kind === "box") {
    if (state.documents.get(source.ref.document_id)?.slot !== slot) {
      throw new CommandError(`${field_key} does not belong to the document the suggestion points at.`, {
        status: 400,
      });
    }
    return;
  }
  const { inputs } = source.ref;
  if (inputs.length === 0) {
    throw new CommandError("A calculated value needs at least one input.", { status: 400 });
  }
  for (const input of inputs) {
    if (slotOfFieldKey(state.proposals.get(input)?.field_key ?? "") !== slot) {
      throw new CommandError(`${field_key} is calculated from a value in a different document.`, {
        status: 400,
      });
    }
  }
}

/**
 * Records a suggested value. Drops it (and says why in the audit log) when it equals the field's
 * current typed or confirmed value; never overwrites a typed value; supersedes a prior `proposed`
 * proposal for the same field and source kind and, for `formula` only, a prior `confirmed` one.
 * A message source fills an application field while the form is a draft. A box or formula source
 * fills a document field while the application's documents are under review.
 */
export function proposeFieldValue(ctx: Ctx, input: ProposeInput): ProposeResult {
  const app = requireApplication(ctx);
  const source = parseOrThrow(ProposalSourceSchema, input.source, "That suggestion has no valid source.");
  const match =
    input.match === undefined
      ? undefined
      : parseOrThrow(MatchResultSchema, input.match, "That suggestion has an invalid match result.");
  const { field_key } = input;
  // First, so that a dropped proposal never records a source that does not exist.
  checkSourceExists(ctx, source);
  requireKeyMatchesSource(field_key, source);

  let value = input.value;
  if (source.kind === "message") {
    // An application field: proposals exist only while the form is open.
    requireDraft(app, "Suggestions can't be added");
    const def = fieldDef(field_key);
    if (!def || !def.copilotFillable) {
      return drop(ctx, field_key, value, source, "field_not_fillable");
    }
    if (value === null) throw new CommandError("A suggestion for the form needs a value.", { status: 400 });
    value = parseOrThrow(
      valueSchemaForField(field_key),
      value,
      `That is not a valid value for ${def.label.toLowerCase()}.`,
    );
    const current = app.fields[field_key];
    if (current && sameValue(current.value, value)) {
      return drop(ctx, field_key, value, source, "equals_confirmed");
    }
  } else if (app.status !== "documents_under_review") {
    // A document value is for the reviewer, so it exists only while a review is open or pending.
    throw new CommandError(
      app.status === "draft"
        ? "Document values can't be suggested before the application is submitted."
        : "Document values can't be suggested after the review is complete.",
    );
  }

  const state = storeWriter();
  const prior = [...state.proposals.values()].filter(
    (p) =>
      p.application_id === app.id &&
      p.field_key === field_key &&
      p.source.kind === source.kind &&
      (p.state === "proposed" || (source.kind === "formula" && p.state === "confirmed")),
  );
  const id = nextId("p");
  const supersededIds = prior.map((p) => p.id);
  const event = audit.emit(
    ctx,
    "field.proposed",
    compact({
      proposal_id: id,
      field_key,
      value,
      source,
      superseded_proposal_ids: supersededIds.length > 0 ? supersededIds : undefined,
    }),
  );
  for (const p of prior) p.state = "superseded";
  const proposal: ProposedValue = compact({
    id,
    application_id: app.id,
    field_key,
    value,
    source,
    match,
    state: "proposed" as const,
    versions: event.versions,
    audit_event_id: event.event_id,
    actor_id: ctx.actor.id,
  });
  state.proposals.set(id, proposal);
  return { proposal: copy(proposal), superseded: supersededIds, event_id: event.event_id };
}

function drop(
  ctx: Ctx,
  field_key: string,
  value: FieldValue | null,
  source: ProposalSource,
  reason: DroppedReason,
): ProposeResult {
  const event = audit.emit(ctx, "field.proposed", {
    proposal_id: null,
    field_key,
    value,
    source,
    dropped_reason: reason,
  });
  return { proposal: null, dropped_reason: reason, superseded: [], event_id: event.event_id };
}

export interface DecisionOptions {
  review_task_id?: string;
  elapsed_ms?: number;
}

export interface ConfirmOptions extends DecisionOptions {
  located_by_reviewer?: boolean;
}

/**
 * Confirms a live proposal. It writes to the application in exactly two cases: a contractor-side
 * confirmation (no task id) writes `fields[key]` with state `confirmed`, and the system's
 * confirmation of `pay_stub.annualized_income` writes `verified.verified_annual_income` with
 * `verification_source = "document_review"`. Every other reviewer-side confirmation writes review
 * data only and never a `stated_*` field.
 */
export function confirmValue(
  ctx: Ctx,
  proposal_id: string,
  options: ConfirmOptions = {},
): { proposal: ProposedValue; event_id: string } {
  const proposal = requireLiveProposal(ctx, proposal_id);
  const app = requireApplication(ctx);
  const { value, field_key } = proposal;
  if (value === null) {
    throw new CommandError("No value was found for this field. Correct it or flag it instead.");
  }
  if (proposal.match?.method === "not_located" && options.located_by_reviewer !== true) {
    throw new CommandError(
      "This value could not be matched to a place on the page. Find it on the page and confirm that you located it yourself.",
    );
  }

  let target: "application" | "verified" | "review_only";
  let verifiedIncome: number | undefined;
  if (options.review_task_id === undefined) {
    requireDraft(app, "Suggestions can't be confirmed");
    if (!isApplicationField(field_key)) {
      throw new CommandError("Document values are confirmed in review.");
    }
    if (ctx.actor.type !== "contractor") {
      throw new CommandError("Only the contractor can confirm a value on the application.");
    }
    target = "application";
  } else {
    requireOpenTask(ctx, options.review_task_id);
    const isAnnualizedIncome =
      ctx.actor.type === "system" &&
      proposal.source.kind === "formula" &&
      field_key === "pay_stub.annualized_income";
    if (isAnnualizedIncome) {
      // The value is about to be stored in `verified`, so it must satisfy that column's schema
      // before the confirmation event exists.
      verifiedIncome = parseOrThrow(
        VerifiedIncomeSchema,
        value,
        "Annualized income must be a whole number of cents, zero or more.",
      );
    }
    target = isAnnualizedIncome ? "verified" : "review_only";
  }

  const event = audit.emit(
    ctx,
    "field.confirmed",
    compact({
      proposal_id,
      field_key,
      source: "proposal" as const,
      final_value: value,
      located_by_reviewer: options.located_by_reviewer,
      review_task_id: options.review_task_id,
      elapsed_ms: options.elapsed_ms,
    }),
  );
  if (target === "application") {
    app.fields[field_key] = { value, state: "confirmed", source_ref: copy(proposal.source) };
  } else if (target === "verified" && verifiedIncome !== undefined) {
    app.verified = { verified_annual_income: verifiedIncome, verification_source: "document_review" };
  }
  proposal.state = "confirmed";
  proposal.confirmed_by = ctx.actor.id;
  proposal.confirmed_at = event.ts;
  if (options.located_by_reviewer !== undefined) {
    proposal.located_by_reviewer = options.located_by_reviewer;
  }
  return { proposal: copy(proposal), event_id: event.event_id };
}

/**
 * Replaces a live proposal's value with a person's own. `edited` is terminal. A contractor-side
 * edit (no task id) writes `fields[key]` with state `edited`; a reviewer-side edit writes review
 * data only. A calculated (formula) value can only be flagged.
 */
export function editValue(
  ctx: Ctx,
  proposal_id: string,
  value: FieldValue,
  options: DecisionOptions = {},
): { proposal: ProposedValue; event_id: string } {
  const proposal = requireLiveProposal(ctx, proposal_id);
  const app = requireApplication(ctx);
  const { field_key } = proposal;
  if (proposal.source.kind === "formula") {
    throw new CommandError("A calculated value can't be edited. Flag it instead.");
  }

  let after: FieldValue = value;
  if (options.review_task_id === undefined) {
    requireDraft(app, "Suggestions can't be edited");
    const def = fieldDef(field_key);
    if (!def) throw new CommandError("Document values are corrected in review.");
    if (ctx.actor.type !== "contractor") {
      throw new CommandError("Only the contractor can edit a value on the application.");
    }
    after = parseOrThrow(
      valueSchemaForField(field_key),
      value,
      `Enter a valid value for ${def.label.toLowerCase()}.`,
    );
  } else {
    requireOpenTask(ctx, options.review_task_id);
  }

  const event = audit.emit(
    ctx,
    "field.edited",
    compact({
      proposal_id,
      field_key,
      before: proposal.value,
      after,
      review_task_id: options.review_task_id,
      elapsed_ms: options.elapsed_ms,
    }),
  );
  if (options.review_task_id === undefined) {
    app.fields[field_key] = { value: after, state: "edited", source_ref: copy(proposal.source) };
  }
  proposal.value = after;
  proposal.state = "edited";
  proposal.confirmed_by = ctx.actor.id;
  proposal.confirmed_at = event.ts;
  return { proposal: copy(proposal), event_id: event.event_id };
}

/**
 * Rejects a live proposal. A contractor dismisses (`dismissed_by_contractor`); a reviewer flags
 * with a `FlagReason` and a task id. Neither writes to the application.
 */
export function rejectValue(
  ctx: Ctx,
  proposal_id: string,
  reason_code: RejectReason,
  options: DecisionOptions & { note?: string } = {},
): { proposal: ProposedValue; event_id: string } {
  const proposal = requireLiveProposal(ctx, proposal_id);
  const app = requireApplication(ctx);
  parseOrThrow(RejectReasonSchema, reason_code, "That is not a known reason.");
  if (options.review_task_id === undefined) {
    requireDraft(app, "Suggestions can't be dismissed");
    parseOrThrow(ContractorRejectReasonSchema, reason_code, "A contractor can only dismiss a suggestion.");
  } else {
    requireOpenTask(ctx, options.review_task_id);
    parseOrThrow(FlagReasonSchema, reason_code, "A reviewer flags a value with a flag reason.");
  }

  const event = audit.emit(
    ctx,
    "field.rejected",
    compact({
      proposal_id,
      field_key: proposal.field_key,
      reason_code,
      note: options.note,
      review_task_id: options.review_task_id,
      elapsed_ms: options.elapsed_ms,
    }),
  );
  proposal.state = "rejected";
  proposal.reason_code = reason_code;
  return { proposal: copy(proposal), event_id: event.event_id };
}

// ---------------------------------------------------------------------------------------------
// Transcript and options
// ---------------------------------------------------------------------------------------------

/**
 * Assigns the message id and emits `message.received`. A message from a `model` actor is stored
 * with the role `assistant`, anything else as `contractor`.
 */
export function appendMessage(
  ctx: Ctx,
  text: string,
): { message: TranscriptMessage; event_id: string } {
  requireApplication(ctx);
  const body = text.trim();
  if (body === "") throw new CommandError("Type a message first.", { status: 400 });
  const id = nextId("m");
  const event = audit.emit(ctx, "message.received", { message_id: id, text: body });
  const message: TranscriptMessage = {
    id,
    application_id: ctx.application_id,
    role: ctx.actor.type === "model" ? "assistant" : "contractor",
    text: body,
    ts: event.ts,
    event_id: event.event_id,
  };
  const state = storeWriter();
  state.messages.set(ctx.application_id, [...(state.messages.get(ctx.application_id) ?? []), message]);
  return { message: copy(message), event_id: event.event_id };
}

/** An id for an Options record, so a caller can name it in a `tool.call` before storing it. */
export function newOptionsId(): string {
  return nextId("opt");
}

export type OptionsRecordInput = Omit<OptionsRecord, "options_id" | "application_id"> & {
  options_id?: string;
};

/** Stores one payment calculation. `options_id` is assigned when the caller did not pre-assign one. */
export function storeOptions(
  ctx: Ctx,
  input: OptionsRecordInput,
): { options: OptionsRecord; event_id: string } {
  requireApplication(ctx);
  const record = parseOrThrow(
    OptionsRecordSchema,
    compact({
      ...input,
      options_id: input.options_id ?? nextId("opt"),
      application_id: ctx.application_id,
      turn_id: input.turn_id ?? ctx.turn_id,
    }),
    "That payment calculation is not valid.",
  );
  const state = storeWriter();
  if (state.options.has(record.options_id)) {
    throw new CommandError(`Payment options ${record.options_id} already exist.`);
  }
  const event = audit.emit(ctx, "options.stored", {
    options_id: record.options_id,
    inputs_source: record.inputs_source,
    product_ids: record.calculator_output.options.map((option) => option.product_id),
  });
  state.options.set(record.options_id, record);
  return { options: copy(record), event_id: event.event_id };
}

/** Attaches the judged explanation text to an Options record, once. */
export function attachExplanation(
  ctx: Ctx,
  options_id: string,
  text: string,
): { event_id: string } {
  requireApplication(ctx);
  const record = storeWriter().options.get(options_id);
  if (!record || record.application_id !== ctx.application_id) {
    throw new CommandError(`Payment options ${options_id} were not found.`, { status: 404 });
  }
  if (record.explanation !== undefined) {
    throw new CommandError("These payment options already have an explanation.");
  }
  const event = audit.emit(ctx, "options.explained", { options_id, text });
  record.explanation = text;
  return { event_id: event.event_id };
}

// ---------------------------------------------------------------------------------------------
// Submission and documents
// ---------------------------------------------------------------------------------------------

/**
 * Stands in for the form's submit request. Throws with the pending count while any proposal is
 * `proposed`, and naming the fields while a required field is empty. Otherwise records the
 * submission, sets `documents_under_review`, calls no service and returns the attached document ids.
 */
export function submitApplication(ctx: Ctx): string[] {
  const app = requireApplication(ctx);
  if (app.status !== "draft") throw new CommandError("This application was already submitted.");

  const pending = store.listProposals(app.id, { state: "proposed" }).length;
  if (pending > 0) {
    throw new CommandError(
      pending === 1
        ? "1 suggestion still needs to be confirmed or dismissed before you can submit."
        : `${pending} suggestions still need to be confirmed or dismissed before you can submit.`,
      { details: { pending_count: pending } },
    );
  }
  const missing = requiredFields().filter((field) => !(field.id in app.fields));
  if (missing.length > 0) {
    throw new CommandError(
      `Fill in the required ${missing.length === 1 ? "field" : "fields"} before submitting: ${missing
        .map((field) => field.label)
        .join(", ")}.`,
      { details: { field_keys: missing.map((field) => field.id) } },
    );
  }

  // One batch: both events are valid and written, or neither is.
  audit.appendAll([
    auditInput(ctx, "application.submitted", {
      fields: Object.fromEntries(Object.entries(app.fields).map(([key, entry]) => [key, entry.value])),
      document_ids: [...app.document_ids],
    }),
    stateChangedInput(ctx, app, "documents_under_review"),
  ]);
  app.status = "documents_under_review";
  return [...app.document_ids];
}

/** The only emitter of `document.attached`. One document per slot. */
export function attachDocument(
  ctx: Ctx,
  slot: DocumentSlot,
  file_ref: string,
  adapter: DocumentAdapter,
  meta: { pages?: DocumentRecord["pages"]; positioned_text_ref?: string } = {},
): { document: DocumentRecord; event_id: string } {
  const app = requireApplication(ctx);
  requireDraft(app, "Documents can't be attached");
  parseOrThrow(DocumentSlotSchema, slot, "That is not a document slot.");
  parseOrThrow(DocumentAdapterSchema, adapter, "That is not a known document reader.");
  const state = storeWriter();
  const taken = [...state.documents.values()].some(
    (d) => d.application_id === app.id && d.slot === slot,
  );
  if (taken) throw new CommandError("A document is already attached to that slot.");

  const id = nextId("doc");
  const event = audit.emit(ctx, "document.attached", { document_id: id, slot, adapter });
  const document: DocumentRecord = {
    id,
    application_id: app.id,
    slot,
    file_ref,
    pages: meta.pages ?? null,
    positioned_text_ref: meta.positioned_text_ref ?? null,
    adapter,
    extraction_status: "pending",
  };
  state.documents.set(id, document);
  app.document_ids.push(id);
  return { document: copy(document), event_id: event.event_id };
}

/** Records how extraction ended for one document. A document leaves `pending` once. */
export function setExtractionStatus(
  ctx: Ctx,
  document_id: string,
  status: ExtractionStatus,
  detail: {
    per_field?: Array<{ field_key: string; match_method: MatchResult["method"]; adapter: DocumentAdapter }>;
    error_code?: ErrorCode;
  } = {},
): { event_id: string } {
  requireApplication(ctx);
  parseOrThrow(ExtractionStatusSchema, status, "That is not an extraction status.");
  const document = storeWriter().documents.get(document_id);
  if (!document || document.application_id !== ctx.application_id) {
    throw new CommandError(`Document ${document_id} was not found.`, { status: 404 });
  }
  if (document.extraction_status !== "pending" || status === "pending") {
    throw new CommandError("This document's extraction has already finished.");
  }
  const event = audit.emit(
    ctx,
    "extraction.completed",
    compact({
      document_id,
      extraction_status: status,
      per_field: detail.per_field ?? [],
      error_code: detail.error_code,
    }),
  );
  document.extraction_status = status;
  return { event_id: event.event_id };
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

/**
 * Opens the review task once every attached document has finished (or failed, or been marked
 * manual). `document_ids`, without repeats, must be exactly the application's attached documents,
 * so neither the pending check nor the all-failed rule can skip a document. A task whose documents
 * all failed is created as `extraction_failed`.
 */
export function createReviewTask(
  ctx: Ctx,
  input: { document_ids: string[]; jsm_issue_id: string },
): { task: ReviewTask; event_id: string } {
  const app = requireApplication(ctx);
  if (app.status === "draft") {
    throw new CommandError("A review task can only be opened after the application is submitted.");
  }
  const state = storeWriter();
  if ([...state.reviewTasks.values()].some((t) => t.application_id === app.id)) {
    throw new CommandError("This application already has a review task.");
  }
  const documentIds = [...new Set(input.document_ids)];
  if (documentIds.length === 0) {
    throw new CommandError("A review task needs at least one document.");
  }
  const documents = documentIds.map((id) => {
    const document = state.documents.get(id);
    if (!document || document.application_id !== app.id) {
      throw new CommandError(`Document ${id} was not found.`, { status: 404 });
    }
    return document;
  });
  const named = new Set(documentIds);
  const leftOut = app.document_ids.filter((id) => !named.has(id));
  const notAttached = documentIds.filter((id) => !app.document_ids.includes(id));
  if (leftOut.length > 0 || notAttached.length > 0) {
    throw new CommandError("A review task must cover every document attached to the application, and only those.", {
      details: { left_out: leftOut, not_attached: notAttached },
    });
  }
  if (documents.some((d) => d.extraction_status === "pending")) {
    throw new CommandError("A review task can only be opened after every document has been read.");
  }

  const id = nextId("task");
  const slot_statuses = Object.fromEntries(documents.map((d) => [d.slot, d.extraction_status]));
  const event = audit.emit(ctx, "review.task_created", {
    task_id: id,
    document_ids: [...documentIds],
    slot_statuses,
    jsm_issue_id: input.jsm_issue_id,
  });
  const task: ReviewTask = {
    id,
    application_id: app.id,
    document_ids: [...documentIds],
    status: documents.every((d) => d.extraction_status === "failed") ? "extraction_failed" : "ready",
    jsm_issue_id: input.jsm_issue_id,
    created_at: event.ts,
  };
  state.reviewTasks.set(id, task);
  return { task: copy(task), event_id: event.event_id };
}

/** Moves a `ready` task to `in_review`. */
export function startReview(ctx: Ctx, task_id: string): { event_id: string } {
  requireApplication(ctx);
  const task = requireOpenTask(ctx, task_id);
  if (task.status !== "ready") {
    throw new CommandError("This review has already started or has nothing to review.");
  }
  const event = audit.emit(ctx, "review.started", { task_id });
  task.status = "in_review";
  return { event_id: event.event_id };
}

/**
 * Completes a review once no proposal of the task is `proposed`: sets the task `complete` and
 * the application `documents_reviewed`.
 */
export function completeReview(ctx: Ctx, task_id: string): { event_ids: string[] } {
  const app = requireApplication(ctx);
  const task = requireOpenTask(ctx, task_id);
  const undecided = store.proposalsForTask(task_id).filter((p) => p.state === "proposed").length;
  if (undecided > 0) {
    throw new CommandError(
      undecided === 1
        ? "1 value still needs a decision before the review can be completed."
        : `${undecided} values still need a decision before the review can be completed.`,
      { details: { undecided_count: undecided } },
    );
  }
  if (app.status !== "documents_under_review") {
    throw new CommandError("This application is not waiting for document review.");
  }
  const open = store.listDiscrepancies(app.id).filter((d) => d.status === "open").length;
  const [completed, changed] = audit.appendAll([
    auditInput(ctx, "review.completed", {
      task_id,
      outcome: "documents_reviewed",
      open_discrepancies: open,
    }),
    stateChangedInput(ctx, app, "documents_reviewed"),
  ]);
  app.status = "documents_reviewed";
  task.status = "complete";
  return { event_ids: [completed.event_id, changed.event_id] };
}

// ---------------------------------------------------------------------------------------------
// Discrepancies
// ---------------------------------------------------------------------------------------------

/**
 * Opens a discrepancy record. The banner does not show until the question is sent. Both value
 * pointers must resolve inside this application: the extracted value to one of its proposals, the
 * stated value to a field of its form or to a confirmed (or edited) proposal.
 */
export function raiseDiscrepancy(
  ctx: Ctx,
  input: DiscrepancyRaiseInput,
): { record: DiscrepancyRecord; event_id: string } {
  const app = requireApplication(ctx);
  if (app.status === "draft") {
    throw new CommandError("Differences are only checked after the application is submitted.");
  }
  const raise = parseOrThrow(DiscrepancyRaiseInputSchema, input, "That discrepancy is not valid.");
  parseOrThrow(DiscrepancyReasonSchema, raise.reason_code, "That is not a discrepancy reason.");
  const task = storeWriter().reviewTasks.get(raise.review_task_id);
  if (!task || task.application_id !== app.id) {
    throw new CommandError(`Review task ${raise.review_task_id} was not found.`, { status: 404 });
  }
  const state = storeWriter();
  const extracted = state.proposals.get(raise.extracted.proposal_id);
  if (!extracted || extracted.application_id !== task.application_id) {
    throw new CommandError("The extracted value was not found on this application.", { status: 404 });
  }
  const { pointer } = raise.stated;
  if (pointer.kind === "form") {
    // The application holds only typed, confirmed and edited values, all of which count as confirmed.
    if (!app.fields[pointer.field_key]) {
      throw new CommandError("The stated value was not found on this application.", { status: 404 });
    }
  } else {
    const stated = state.proposals.get(pointer.proposal_id);
    if (!stated || stated.application_id !== app.id) {
      throw new CommandError("The stated value was not found on this application.", { status: 404 });
    }
    if (stated.state !== "confirmed" && stated.state !== "edited") {
      throw new CommandError("The stated value has not been confirmed.");
    }
  }
  const record: DiscrepancyRecord = { ...raise, id: nextId("disc"), application_id: app.id, status: "open" };
  const event = audit.emit(ctx, "discrepancy.raised", { record });
  storeWriter().discrepancies.set(record.id, record);
  return { record: copy(record), event_id: event.event_id };
}

/** Sends the (possibly edited) question to the contractor: sets `sent_at`, which shows the banner. */
export function sendDiscrepancyQuestion(
  ctx: Ctx,
  record_id: string,
  text: string,
): { record: DiscrepancyRecord; event_id: string } {
  requireApplication(ctx);
  const record = requireDiscrepancy(ctx, record_id);
  if (record.status !== "open") throw new CommandError("This question is already resolved.");
  if (record.sent_at !== undefined) throw new CommandError("This question was already sent.");
  const body = text.trim();
  if (body === "") throw new CommandError("Write the question before sending it.", { status: 400 });
  const next: DiscrepancyRecord = {
    ...record,
    question: { ...record.question, text: body },
    sent_at: nowIso(),
  };
  const event = audit.emit(ctx, "discrepancy.sent", { record: next });
  Object.assign(record, next);
  return { record: copy(record), event_id: event.event_id };
}

/** Records the contractor's reply to a question that has been sent. */
export function replyToDiscrepancy(
  ctx: Ctx,
  record_id: string,
  text: string,
): { record: DiscrepancyRecord; event_id: string } {
  requireApplication(ctx);
  const record = requireDiscrepancy(ctx, record_id);
  if (record.status !== "open" || record.sent_at === undefined) {
    throw new CommandError("There is no open question to answer.");
  }
  if (record.contractor_reply !== undefined) {
    throw new CommandError("This question was already answered.");
  }
  const body = text.trim();
  if (body === "") throw new CommandError("Type a reply first.", { status: 400 });
  const next: DiscrepancyRecord = { ...record, contractor_reply: { text: body, at: nowIso() } };
  const event = audit.emit(ctx, "discrepancy.replied", { record: next });
  Object.assign(record, next);
  return { record: copy(record), event_id: event.event_id };
}

/**
 * Closes a record as `explained` (both values stand; the note says why) or `corrected` (the reply
 * supplied a corrected figure, recorded in the note; the stated value changes outside this system).
 */
export function resolveDiscrepancy(
  ctx: Ctx,
  record_id: string,
  input: { resolution: DiscrepancyResolution; note: string },
): { record: DiscrepancyRecord; event_id: string } {
  requireApplication(ctx);
  const record = requireDiscrepancy(ctx, record_id);
  if (record.status !== "open") throw new CommandError("This question is already resolved.");
  if (record.sent_at === undefined) {
    throw new CommandError("Send the question to the contractor before resolving it.");
  }
  const resolution = parseOrThrow(
    DiscrepancyResolutionSchema,
    input.resolution,
    "Choose whether the difference was explained or corrected.",
  );
  const note = input.note.trim();
  if (note === "") throw new CommandError("Add a note explaining the resolution.", { status: 400 });
  const next: DiscrepancyRecord = {
    ...record,
    status: "resolved",
    resolution,
    resolver: ctx.actor.id,
    note,
  };
  const event = audit.emit(ctx, "discrepancy.resolved", { record: next });
  Object.assign(record, next);
  return { record: copy(record), event_id: event.event_id };
}
