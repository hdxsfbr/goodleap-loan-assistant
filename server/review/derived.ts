import {
  PAY_FREQUENCIES,
  PERIODS_PER_YEAR,
  fieldKeyFor,
  schemaForSlot,
  type DocumentFieldDef,
  type PayFrequency,
} from "@shared/document-schemas/index";
import type { FlagReason } from "@shared/reason-codes";
import type { Actor, DocumentSlot, ProposalSourceKind, ProposedValue } from "@shared/schemas";
import type { Ctx } from "../audit-log.js";
import { confirmValue, proposeFieldValue, rejectValue, withdrawVerifiedValue } from "../commands.js";
import { CommandError } from "../errors.js";
import { store } from "../store.js";

// Derived fields belong to the review path: the extraction consumer never computes them and the
// model never reads them. A derived value is a formula proposal that points at the proposals it
// was computed from, confirmed by the system actor (the confirmation that writes
// `verified_annual_income`). It exists only once every input is final. Called by tasks.ts after
// any value command on an input and once when the task opens; never by a command.

const SYSTEM_ACTOR: Actor = { type: "system", id: "system" };

/** The one derived value whose confirmation is stored as `verified_annual_income`. */
const VERIFIED_FIELD_KEY = "pay_stub.annualized_income";

/** The audit note on the withdrawal that precedes a recomputed value. */
const RECOMPUTED_NOTE = "An input was corrected, so the value was calculated again.";

export function isPayFrequency(value: unknown): value is PayFrequency {
  return typeof value === "string" && (PAY_FREQUENCIES as readonly string[]).includes(value);
}

/** Gross pay for one period times the pay periods in a year; integer cents in, integer cents out. */
export function annualize(grossCents: number, frequency: PayFrequency): number {
  return grossCents * PERIODS_PER_YEAR[frequency];
}

/** The newest proposal for a key and source kind, or undefined. */
export function currentProposal(
  applicationId: string,
  fieldKey: string,
  kind: ProposalSourceKind,
): ProposedValue | undefined {
  return store.listProposals(applicationId, { field_key: fieldKey, source_kind: kind }).at(-1);
}

/**
 * Takes back the stored verification of a confirmed derived value that is about to be flagged or
 * replaced. Does nothing for a value that is not confirmed or does not write `verified`. The
 * command appends the audit event; the caller supersedes the proposal next.
 */
export function withdrawVerification(
  ctx: Ctx,
  taskId: string,
  previous: ProposedValue | undefined,
  reason: FlagReason,
  note?: string,
): void {
  if (previous?.state !== "confirmed" || previous.source.kind !== "formula") return;
  if (previous.field_key !== VERIFIED_FIELD_KEY) return;
  withdrawVerifiedValue({ ...ctx, actor: SYSTEM_ACTOR }, previous.field_key, {
    proposal_id: previous.id,
    reason_code: reason,
    review_task_id: taskId,
    ...(note === undefined ? {} : { note }),
  });
}

/** An input the reviewer cannot confirm: flagged, or never found (a proposal with no value). */
function isMissing(proposal: ProposedValue): boolean {
  return proposal.state === "rejected" || (proposal.state === "proposed" && proposal.value === null);
}

export type DerivedInputState =
  /** The document produced no proposal for an input, so there is no row to compute. */
  | { kind: "absent" }
  /** An input is flagged or was not extracted; `reason` is the flag the derived row carries. */
  | { kind: "missing"; reason: FlagReason; inputs: ProposedValue[] }
  /** Every input has a value and at least one still waits for the reviewer. */
  | { kind: "waiting"; inputs: ProposedValue[] }
  /** Every input is confirmed or edited. */
  | { kind: "ready"; inputs: ProposedValue[] };

/** Where a derived field stands, from the state of its inputs (design item 45). */
export function derivedInputState(applicationId: string, slot: DocumentSlot, field: DocumentFieldDef): DerivedInputState {
  const derived = field.derived;
  if (!derived) return { kind: "absent" };
  const inputs: ProposedValue[] = [];
  for (const id of derived.inputs) {
    const proposal = currentProposal(applicationId, fieldKeyFor(slot, id), "box");
    if (!proposal) return { kind: "absent" };
    inputs.push(proposal);
  }
  const frequencyKey = fieldKeyFor(slot, "pay_frequency");
  const missing = inputs.filter(isMissing);
  if (missing.length > 0) {
    const reason: FlagReason = missing.some((p) => p.field_key === frequencyKey)
      ? "pay_frequency_not_located"
      : "source_not_located";
    return { kind: "missing", reason, inputs };
  }
  if (inputs.some((p) => p.state === "proposed")) return { kind: "waiting", inputs };
  return { kind: "ready", inputs };
}

/**
 * Brings the derived values of a task up to date with their inputs. With `changedFieldKey`, only
 * the derived fields that take that field as an input are looked at. For each:
 *  - an input is flagged or was not extracted: a formula proposal with no value is created and
 *    rejected (`pay_frequency_not_located` when the pay frequency is the missing input,
 *    `source_not_located` otherwise), so the reviewer row exists; one already there is kept;
 *  - an input still waits for a decision: nothing happens, and the reviewer sees the formula row
 *    with no value;
 *  - every input is confirmed or edited: the annualized income is gross pay times the pay periods
 *    per year, proposed as a formula proposal (superseding the previous one) and confirmed by the
 *    system; when the previous one was confirmed, the verification it wrote is withdrawn first.
 * Returns the derived proposals confirmed by this call, for the caller to compare.
 */
export function recomputeDerived(ctx: Ctx, taskId: string, changedFieldKey?: string): ProposedValue[] {
  const task = store.getReviewTask(taskId);
  if (!task) throw new CommandError(`Review task ${taskId} was not found.`, { status: 404 });
  const system: Ctx = { ...ctx, actor: SYSTEM_ACTOR };
  const confirmed: ProposedValue[] = [];

  for (const documentId of task.document_ids) {
    const doc = store.getDocument(documentId);
    if (!doc || doc.extraction_status !== "done") continue;
    for (const field of schemaForSlot(doc.slot).fields) {
      if (!field.derived) continue;
      const inputKeys = field.derived.inputs.map((id) => fieldKeyFor(doc.slot, id));
      if (changedFieldKey !== undefined && !inputKeys.includes(changedFieldKey)) continue;

      const state = derivedInputState(task.application_id, doc.slot, field);
      if (state.kind === "absent" || state.kind === "waiting") continue;

      const derivedKey = fieldKeyFor(doc.slot, field.id);
      const source = {
        kind: "formula" as const,
        ref: { formula: field.derived.formula, inputs: state.inputs.map((p) => p.id) },
      };
      const current = currentProposal(task.application_id, derivedKey, "formula");

      if (state.kind === "missing") {
        if (current?.state === "rejected" && current.value === null && current.reason_code === state.reason) continue;
        withdrawVerification(system, taskId, current, state.reason, RECOMPUTED_NOTE);
        const { proposal } = proposeFieldValue(system, { field_key: derivedKey, value: null, source });
        if (proposal) rejectValue(system, proposal.id, state.reason, { review_task_id: taskId });
        continue;
      }

      const gross = state.inputs[0]?.value;
      const frequency = state.inputs[1]?.value;
      if (typeof gross !== "number" || !isPayFrequency(frequency)) continue;
      const value = annualize(gross, frequency);
      const sameInputs =
        current?.source.kind === "formula" &&
        current.source.ref.inputs.join() === source.ref.inputs.join();
      if (current?.state === "confirmed" && current.value === value && sameInputs) continue;

      // The value being replaced no longer stands behind the stored verification.
      withdrawVerification(system, taskId, current, "other", RECOMPUTED_NOTE);
      const { proposal } = proposeFieldValue(system, { field_key: derivedKey, value, source });
      if (!proposal) continue;
      confirmed.push(confirmValue(system, proposal.id, { review_task_id: taskId }).proposal);
    }
  }
  return confirmed;
}
