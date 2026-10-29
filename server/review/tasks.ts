import { fieldDef } from "@shared/application-schema";
import {
  DOCUMENT_SCHEMAS,
  fieldForKey,
  fieldKeyFor,
  parseCorrection,
  schemaForSlot,
  type DocumentFieldDef,
  type DocumentFieldType,
} from "@shared/document-schemas/index";
import type { FlagReason, RejectReason } from "@shared/reason-codes";
import type {
  Actor,
  ApplicationStatus,
  AuditEvent,
  DecisionRequest,
  DiscrepancyRecord,
  DocumentRecord,
  DocumentSlot,
  ErrorCode,
  ExtractionStatus,
  FieldValue,
  ProposalState,
  ProposedValue,
  ReviewTask,
} from "@shared/schemas";
import { audit, type Ctx } from "../audit-log.js";
import {
  completeReview,
  confirmValue,
  createReviewTask,
  editValue,
  proposeFieldValue,
  rejectValue,
  setExtractionStatus,
  startReview,
} from "../commands.js";
import { CommandError } from "../errors.js";
import { services, withMock } from "../services/index.js";
import { store } from "../store.js";
import { compareOnConfirm, ruleText } from "./discrepancy.js";
import { currentProposal, derivedInputState, recomputeDerived, withdrawVerification } from "./derived.js";
import { singleFlight } from "./single-flight.js";
import { LOCATED_ACK, NOT_LOCATED_CAPTION, reviewerFlagReasonLabels, type ReviewerFlagReason } from "./templates.js";

// The review task lifecycle: opening the task once every slot has finished, the view the
// reviewer screen renders, and the reviewer's decisions. A decision is one value command, then the
// derived values that depend on the field are brought up to date, then the discrepancy engine
// compares whatever has a `compareTo`. The commands themselves never call any of that.

const SYSTEM_ACTOR: Actor = { type: "system", id: "system" };

// ---------------------------------------------------------------------------------------------
// Opening the task
// ---------------------------------------------------------------------------------------------

/** True when the queue was already told about this task: an `addLink` for the issue that did not fail. */
function linkRecorded(applicationId: string, jsmIssueId: string): boolean {
  return audit.list(applicationId).some((event) => {
    if (event.type !== "tool.call" || event.service !== "review_queue" || event.method !== "addLink") return false;
    const input = event.input as { jsm_issue_id?: unknown } | null;
    const output = event.output as { error?: unknown } | null;
    return input?.jsm_issue_id === jsmIssueId && !(output !== null && typeof output === "object" && "error" in output);
  });
}

/** The issue an earlier attempt created but never turned into a task, if there is one. */
function unclaimedIssue(applicationId: string): string | undefined {
  for (const event of audit.list(applicationId).reverse()) {
    if (event.type !== "tool.call" || event.service !== "review_queue" || event.method !== "createIssue") continue;
    const output = event.output as { jsm_issue_id?: unknown } | null;
    if (typeof output?.jsm_issue_id === "string") return output.jsm_issue_id;
  }
  return undefined;
}

/**
 * Opens the review task for an application once every slot has finished, failed or been marked
 * manual: the review queue's `createIssue`, the `createReviewTask` command with the issue id,
 * then the queue's `addLink`. With `manual`, every document still pending is first marked
 * `manual` (extraction is switched off) and the task opens with no proposals. A task whose
 * documents all failed is created as `extraction_failed`. Returns null when the application has
 * no documents.
 *
 * Safe to call again: once the task exists it is returned as it is, with the issue it already
 * has (no second issue is created), and a link the queue was never given is added then; an
 * issue created by an attempt that failed before the task existed is the one the task is given.
 * Calls that overlap share one run.
 */
export function openReviewTask(
  ctx: Ctx,
  applicationId: string,
  options: { manual: boolean },
): Promise<ReviewTask | null> {
  return singleFlight(applicationId, "open-review-task", () => open(ctx, applicationId, options));
}

async function open(ctx: Ctx, applicationId: string, options: { manual: boolean }): Promise<ReviewTask | null> {
  const documents = store.listDocuments(applicationId);
  if (documents.length === 0) return null;
  const scoped: Ctx = { ...ctx, application_id: applicationId };

  let task = store.listReviewTasks(applicationId)[0];
  if (!task) {
    if (options.manual) {
      for (const doc of documents) {
        if (doc.extraction_status === "pending") setExtractionStatus(scoped, doc.id, "manual");
      }
    } else if (documents.some((d) => d.extraction_status === "pending")) {
      // Before the queue is asked for an issue the task could not be created for.
      throw new CommandError("A review task can only be opened after every document has been read.");
    }
    const summary = `Document review for application ${applicationId}: ${documents.map((d) => schemaForSlot(d.slot).title.toLowerCase()).join(", ")}`;
    const jsmIssueId =
      unclaimedIssue(applicationId) ??
      (
        await withMock(
          scoped,
          "review_queue",
          "createIssue",
          () => services.reviewQueue.createIssue({ application_id: applicationId, summary }),
          { input: { application_id: applicationId, summary } },
        )
      ).jsm_issue_id;
    task = createReviewTask(scoped, {
      document_ids: documents.map((d) => d.id),
      jsm_issue_id: jsmIssueId,
    }).task;
  }

  if (!linkRecorded(applicationId, task.jsm_issue_id)) {
    const link = { task_id: task.id, url: `/review/${task.id}` };
    const { jsm_issue_id } = task;
    await withMock(
      scoped,
      "review_queue",
      "addLink",
      () => services.reviewQueue.addLink(jsm_issue_id, link),
      { input: { jsm_issue_id, ...link } },
    );
  }
  // Inputs that were not extracted already give the derived value its flagged row.
  if (task.status !== "complete") recomputeDerived(scoped, task.id);
  return task;
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

export type DecisionAction = "confirm" | "correct" | "flag";
export type RowStatus = "undecided" | "confirmed" | "edited" | "flagged" | "waiting";
/** The two box states, plus a value never found and a value that is computed. */
export type RowLocation = "located" | "not_located" | "not_extracted" | "derived";

export interface TaskDecision {
  event_id: string;
  ts: string;
  actor: Actor;
  action: DecisionAction;
  field_key: string;
  proposal_id: string;
  /** The confirmed value (confirm) or the corrected value (correct). */
  value?: FieldValue;
  /** The value before a correction. */
  before?: FieldValue | null;
  reason_code?: RejectReason;
  note?: string;
  located_by_reviewer?: boolean;
  elapsed_ms?: number;
}

export interface DerivedInputView {
  field_id: string;
  field_key: string;
  label: string;
  proposal_id: string | null;
  value: FieldValue | null;
  state: ProposalState | null;
}

export interface TaskFieldRow {
  field_key: string;
  field_id: string;
  label: string;
  type: DocumentFieldType;
  description: string;
  /** The enum values a corrected value may take. */
  options: string[] | null;
  /** The live proposal for the field, or the latest one once decided; null while a derived value waits for its inputs. */
  proposal: ProposedValue | null;
  status: RowStatus;
  location: RowLocation;
  /** `extraction.source_not_located` for a value whose position could not be matched. */
  error_code: ErrorCode | null;
  /**
   * What the reviewer may do with the row now; empty once it has a state, except that a decided
   * value a formula reads (gross pay, pay frequency) can still be corrected while the review is open.
   */
  actions: DecisionAction[];
  /** True when confirming needs the acknowledgement that the reviewer located the value. */
  requires_acknowledgement: boolean;
  /** The reviewer's decision on this proposal, when there is one. */
  decision: TaskDecision | null;
  /** The formula and the proposals it points at, for a derived value. */
  formula: { name: string; inputs: DerivedInputView[] } | null;
  /** The application value this one is compared to. */
  compare_to: { field_id: string; label: string; stated_value: FieldValue | null } | null;
}

export interface TaskDocumentFlag {
  kind: "wrong_document_type" | "manual_reading";
  reason_code: FlagReason | null;
  text: string;
}

export interface TaskDocumentView {
  id: string;
  slot: DocumentSlot;
  title: string;
  extraction_status: ExtractionStatus;
  adapter: DocumentRecord["adapter"];
  /** Where the page can be fetched: `GET` returns the PDF. */
  file_url: string;
  flag: TaskDocumentFlag | null;
  rows: TaskFieldRow[];
}

export interface TaskDiscrepancyView {
  record: DiscrepancyRecord;
  /** The rule as text, for example "differs by more than 10%". */
  rule_text: string;
  field_label: string;
  stated_label: string;
}

export interface TaskView {
  task: ReviewTask;
  application: { id: string; status: ApplicationStatus };
  documents: TaskDocumentView[];
  discrepancies: TaskDiscrepancyView[];
  decisions: TaskDecision[];
  /** Values still waiting for a decision. */
  undecided_count: number;
  /** True when no proposal of the task is still waiting for a decision. */
  can_complete: boolean;
  /** Fixed texts the screen shows. */
  texts: {
    not_located_caption: string;
    located_acknowledgement: string;
    /** The reasons a reviewer may choose when flagging a value; the ones only the system writes are left out. */
    flag_reasons: Record<ReviewerFlagReason, string>;
  };
}

export interface TaskSummary {
  id: string;
  application_id: string;
  status: ReviewTask["status"];
  jsm_issue_id: string;
  created_at: string;
  document_count: number;
  undecided_count: number;
  open_discrepancies: number;
}

function requireTask(taskId: string): ReviewTask {
  const task = store.getReviewTask(taskId);
  if (!task) throw new CommandError(`Review task ${taskId} was not found.`, { status: 404 });
  return task;
}

function undecidedCount(taskId: string): number {
  return store.proposalsForTask(taskId).filter((p) => p.state === "proposed").length;
}

export function listTaskSummaries(): TaskSummary[] {
  return store.listReviewTasks().map((task) => ({
    id: task.id,
    application_id: task.application_id,
    status: task.status,
    jsm_issue_id: task.jsm_issue_id,
    created_at: task.created_at,
    document_count: task.document_ids.length,
    undecided_count: undecidedCount(task.id),
    open_discrepancies: store
      .listDiscrepancies(task.application_id)
      .filter((d) => d.status === "open" && d.review_task_id === task.id).length,
  }));
}

/** The reviewer's decisions on a task, from its `field.*` audit events carrying the task id. */
function decisionsOf(task: ReviewTask): TaskDecision[] {
  const decisions: TaskDecision[] = [];
  for (const event of audit.list(task.application_id) as AuditEvent[]) {
    if (event.type === "field.confirmed" && event.review_task_id === task.id && event.proposal_id !== null) {
      decisions.push({
        event_id: event.event_id,
        ts: event.ts,
        actor: event.actor,
        action: "confirm",
        field_key: event.field_key,
        proposal_id: event.proposal_id,
        value: event.final_value,
        ...(event.located_by_reviewer === undefined ? {} : { located_by_reviewer: event.located_by_reviewer }),
        ...(event.elapsed_ms === undefined ? {} : { elapsed_ms: event.elapsed_ms }),
      });
    } else if (event.type === "field.edited" && event.review_task_id === task.id) {
      decisions.push({
        event_id: event.event_id,
        ts: event.ts,
        actor: event.actor,
        action: "correct",
        field_key: event.field_key,
        proposal_id: event.proposal_id,
        value: event.after,
        before: event.before,
        ...(event.elapsed_ms === undefined ? {} : { elapsed_ms: event.elapsed_ms }),
      });
    } else if (event.type === "field.rejected" && event.review_task_id === task.id) {
      decisions.push({
        event_id: event.event_id,
        ts: event.ts,
        actor: event.actor,
        action: "flag",
        field_key: event.field_key,
        proposal_id: event.proposal_id,
        reason_code: event.reason_code,
        ...(event.note === undefined ? {} : { note: event.note }),
        ...(event.elapsed_ms === undefined ? {} : { elapsed_ms: event.elapsed_ms }),
      });
    }
  }
  return decisions;
}

function documentFlag(doc: DocumentRecord): TaskDocumentFlag | null {
  const title = schemaForSlot(doc.slot).title.toLowerCase();
  switch (doc.extraction_status) {
    case "type_mismatch":
      return {
        kind: "wrong_document_type",
        reason_code: "wrong_document_type",
        text: `This document does not look like a ${title}, so no values were read from it. Check it on the page.`,
      };
    case "failed":
      return { kind: "manual_reading", reason_code: null, text: "This document could not be read automatically. Read it on the page." };
    case "manual":
      return { kind: "manual_reading", reason_code: null, text: "This document was not read automatically. Read it on the page." };
    default:
      return null;
  }
}

function rowStatus(proposal: ProposedValue | null): RowStatus {
  if (!proposal) return "waiting";
  switch (proposal.state) {
    case "confirmed":
      return "confirmed";
    case "edited":
      return "edited";
    case "rejected":
      return "flagged";
    default:
      return "undecided";
  }
}

function buildRow(
  applicationId: string,
  doc: DocumentRecord,
  field: DocumentFieldDef,
  decisions: TaskDecision[],
  reviewOpen: boolean,
): TaskFieldRow {
  const key = fieldKeyFor(doc.slot, field.id);
  const schema = schemaForSlot(doc.slot);
  let proposal = currentProposal(applicationId, key, field.derived ? "formula" : "box") ?? null;

  let formula: TaskFieldRow["formula"] = null;
  if (field.derived) {
    const state = derivedInputState(applicationId, doc.slot, field);
    // A flag row for an input that has since been corrected is stale: the value waits for the rest.
    if (proposal?.state === "rejected" && proposal.value === null && state.kind === "waiting") proposal = null;
    formula = {
      name: field.derived.formula,
      inputs: field.derived.inputs.map((id) => {
        const input = schema.fields.find((f) => f.id === id);
        const p = currentProposal(applicationId, fieldKeyFor(doc.slot, id), "box");
        return {
          field_id: id,
          field_key: fieldKeyFor(doc.slot, id),
          label: input?.label ?? id,
          proposal_id: p?.id ?? null,
          value: p?.value ?? null,
          state: p?.state ?? null,
        };
      }),
    };
  }

  const status = rowStatus(proposal);
  const method = proposal?.match?.method;
  const location: RowLocation = field.derived
    ? "derived"
    : method === "not_located"
      ? "not_located"
      : method === "not_extracted" || proposal?.value === null
        ? "not_extracted"
        : "located";

  let actions: DecisionAction[] = [];
  if (proposal && field.derived) {
    actions = proposal.state === "proposed" || proposal.state === "confirmed" ? ["flag"] : [];
  } else if (proposal?.state === "proposed") {
    actions = proposal.value === null ? ["correct", "flag"] : ["confirm", "correct", "flag"];
  } else if (reviewOpen && proposal && isDecidedFormulaInput(proposal)) {
    // Only the newest decided proposal of an input can be corrected; the income is calculated again.
    actions = ["correct"];
  }

  const compareField = field.compareTo ? fieldDef(field.compareTo) : undefined;
  const app = store.getApplication(applicationId);
  const stated = field.compareTo ? app?.fields[field.compareTo] : undefined;
  const decision =
    (proposal ? decisions.filter((d) => d.proposal_id === proposal.id).at(-1) : undefined) ?? null;

  return {
    field_key: key,
    field_id: field.id,
    label: field.label,
    type: field.type,
    description: field.description,
    options: field.options ? [...field.options] : null,
    proposal,
    status,
    location,
    error_code: location === "not_located" ? "extraction.source_not_located" : null,
    actions,
    requires_acknowledgement: location === "not_located" && proposal?.state === "proposed" && proposal.value !== null,
    decision,
    formula,
    compare_to:
      field.compareTo && compareField
        ? { field_id: field.compareTo, label: compareField.label, stated_value: stated?.value ?? null }
        : null,
  };
}

/** Everything the reviewer screen renders for one task. JSON-clean. */
export function taskView(taskId: string): TaskView {
  const task = requireTask(taskId);
  const application = store.getApplication(task.application_id);
  if (!application) throw new CommandError(`Application ${task.application_id} was not found.`, { status: 404 });
  const decisions = decisionsOf(task);

  const documents: TaskDocumentView[] = task.document_ids.flatMap((id) => {
    const doc = store.getDocument(id);
    if (!doc) return [];
    const schema = schemaForSlot(doc.slot);
    return [
      {
        id: doc.id,
        slot: doc.slot,
        title: schema.title,
        extraction_status: doc.extraction_status,
        adapter: doc.adapter,
        file_url: `/api/documents/${doc.id}/file`,
        flag: documentFlag(doc),
        rows:
          doc.extraction_status === "done"
            ? schema.fields.map((field) => buildRow(application.id, doc, field, decisions, task.status !== "complete"))
            : [],
      },
    ];
  });

  const discrepancies: TaskDiscrepancyView[] = store
    .listDiscrepancies(application.id)
    .filter((record) => record.review_task_id === task.id)
    .map((record) => {
      const dot = record.field_key.indexOf(".");
      const slot = record.field_key.slice(0, dot) as DocumentSlot;
      const schema = DOCUMENT_SCHEMAS[slot];
      const field = schema?.fields.find((f) => f.id === record.field_key.slice(dot + 1));
      return {
        record,
        rule_text: field && schema ? ruleText(field, schema.title) : "",
        field_label: field?.label ?? record.field_key,
        stated_label: (field?.compareTo ? fieldDef(field.compareTo)?.label : undefined) ?? "Application value",
      };
    });

  const undecided = undecidedCount(task.id);
  return {
    task,
    application: { id: application.id, status: application.status },
    documents,
    discrepancies,
    decisions,
    undecided_count: undecided,
    can_complete: undecided === 0 && task.status !== "complete",
    texts: {
      not_located_caption: NOT_LOCATED_CAPTION,
      located_acknowledgement: LOCATED_ACK,
      flag_reasons: reviewerFlagReasonLabels(),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

/**
 * Flags a derived value. A confirmed one first has its verification withdrawn, then is replaced by
 * a proposal with no value (a formula proposal supersedes its predecessor, confirmed or not),
 * because a confirmed proposal cannot be rejected; the reviewer's flag lands on the replacement.
 */
function flagDerived(
  ctx: Ctx,
  taskId: string,
  proposal: ProposedValue,
  reason: FlagReason,
  options: { elapsed_ms: number; note?: string },
): void {
  let target = proposal;
  if (proposal.state === "confirmed") {
    // The flagged value no longer stands behind the verified income.
    withdrawVerification({ ...ctx, actor: SYSTEM_ACTOR }, taskId, proposal, reason);
    const replaced = proposeFieldValue({ ...ctx, actor: SYSTEM_ACTOR }, {
      field_key: proposal.field_key,
      value: null,
      source: proposal.source,
    }).proposal;
    if (replaced) target = replaced;
  }
  rejectValue(ctx, target.id, reason, {
    review_task_id: taskId,
    elapsed_ms: options.elapsed_ms,
    ...(options.note === undefined ? {} : { note: options.note }),
  });
}

/** True for a confirmed or edited value, the newest for its field, that is an input of a derived value. */
function isDecidedFormulaInput(proposal: ProposedValue): boolean {
  if (proposal.source.kind !== "box") return false;
  if (proposal.state !== "confirmed" && proposal.state !== "edited") return false;
  const found = fieldForKey(proposal.field_key);
  if (!found) return false;
  const feedsFormula = found.schema.fields.some((f) => f.derived?.inputs.includes(found.field.id));
  return feedsFormula && currentProposal(proposal.application_id, proposal.field_key, "box")?.id === proposal.id;
}

/** A new proposal for a decided value, with the same value, source and match, ready for the correction. */
function reopen(system: Ctx, decided: ProposedValue): string {
  const { proposal } = proposeFieldValue(system, {
    field_key: decided.field_key,
    value: decided.value,
    source: decided.source,
    ...(decided.match === undefined ? {} : { match: decided.match }),
  });
  if (!proposal) throw new CommandError("That value could not be corrected.");
  return proposal.id;
}

/**
 * Applies one reviewer decision to a proposal of a task: the first one starts the review; then
 * `confirmValue`, `editValue` or `rejectValue` with the reviewer as actor, the task id and the
 * time since the task was created; then any derived value that depends on the field is brought up
 * to date; then whatever has a `compareTo` is compared. A derived value accepts `flag` only. A
 * value that a formula reads (gross pay, pay frequency) accepts `correct` after it was decided:
 * the correction goes onto a fresh proposal and the derived income is calculated again.
 * `correct` takes the value as the reviewer typed it ("$4,250.00", "10/05/2026", "Biweekly") or
 * the stored form (integer cents for money). A value that has no value yet (`not_extracted`) is
 * flagged as `missing` when no reason is given. Returns the refreshed task view.
 */
export function applyDecision(
  ctx: Ctx,
  taskId: string,
  proposalId: string,
  request: DecisionRequest,
): TaskView {
  const task = requireTask(taskId);
  if (task.status === "complete") throw new CommandError("This review is already complete.");
  const proposal = store.getProposal(proposalId);
  if (!proposal || !store.proposalsForTask(taskId).some((p) => p.id === proposalId)) {
    throw new CommandError("That value is not part of this review.", { status: 404 });
  }
  const derived = proposal.source.kind === "formula";
  const waiting = proposal.state === "proposed";
  // A value a formula reads can be corrected after it was decided: the income is calculated again.
  const recorrection = request.action === "correct" && isDecidedFormulaInput(proposal);
  if (!waiting && !recorrection && !(derived && proposal.state === "confirmed")) {
    throw new CommandError("This value already has a decision.");
  }
  if (derived && request.action !== "flag") {
    throw new CommandError("A calculated value can only be flagged.");
  }

  // Everything that can be wrong with the request is checked before the review starts, so a
  // refused decision leaves the task as it was.
  const found = proposal.field_key.indexOf(".");
  const slot = proposal.field_key.slice(0, found) as DocumentSlot;
  const field = DOCUMENT_SCHEMAS[slot]?.fields.find((f) => f.id === proposal.field_key.slice(found + 1));
  if (!field) throw new CommandError("That value is not part of this review.", { status: 404 });

  let correctedValue: FieldValue | undefined;
  let reason: FlagReason | undefined;
  if (request.action === "confirm") {
    if (proposal.value === null) {
      throw new CommandError("No value was found for this field. Correct it or flag it instead.");
    }
    if (proposal.match?.method === "not_located" && request.located_by_reviewer !== true) {
      throw new CommandError(`Find the value on the page and confirm it: "${LOCATED_ACK}".`);
    }
  } else if (request.action === "correct") {
    if (request.value === undefined) throw new CommandError("Enter the value you read from the page.", { status: 400 });
    const parsed = parseCorrection(field, request.value);
    if (!parsed.ok) throw new CommandError(parsed.error, { status: 400 });
    correctedValue = parsed.value;
  } else {
    reason = request.reason_code ?? (proposal.value === null ? "missing" : undefined);
    if (reason === undefined) throw new CommandError("Choose a reason for flagging this value.", { status: 400 });
  }

  if (task.status === "ready") startReview(ctx, taskId);
  const options = { review_task_id: taskId, elapsed_ms: Math.max(0, Date.now() - Date.parse(task.created_at)) };
  const system: Ctx = { ...ctx, actor: SYSTEM_ACTOR };

  let decided: ProposedValue | undefined;
  if (request.action === "confirm") {
    decided = confirmValue(ctx, proposalId, {
      ...options,
      ...(proposal.match?.method === "not_located" ? { located_by_reviewer: true } : {}),
    }).proposal;
  } else if (request.action === "correct" && correctedValue !== undefined) {
    // A decided value cannot be edited in place, so the correction goes onto a new proposal that
    // carries the decided value and the place it was read from.
    const target = recorrection ? reopen(system, proposal) : proposalId;
    decided = editValue(ctx, target, correctedValue, options).proposal;
  } else if (reason !== undefined) {
    if (derived) {
      flagDerived(ctx, taskId, proposal, reason, { elapsed_ms: options.elapsed_ms, ...(request.note === undefined ? {} : { note: request.note }) });
    } else {
      rejectValue(ctx, proposalId, reason, { ...options, ...(request.note === undefined ? {} : { note: request.note }) });
    }
  }

  for (const value of recomputeDerived(ctx, taskId, proposal.field_key)) compareOnConfirm(system, value, taskId);
  if (decided && field.compareTo) compareOnConfirm(system, decided, taskId);
  return taskView(taskId);
}

/** Completes the review: the task is `complete` and the application `documents_reviewed`. */
export function complete(ctx: Ctx, taskId: string): TaskView {
  completeReview(ctx, taskId);
  return taskView(taskId);
}
