import { fieldDef } from "@shared/application-schema";
import { fieldForKey, type DocumentFieldDef, type Tolerance } from "@shared/document-schemas/index";
import { formatMoney } from "@shared/format";
import type { DiscrepancyRecord, ProposedValue } from "@shared/schemas";
import type { Ctx } from "../audit-log.js";
import { raiseDiscrepancy } from "../commands.js";
import { CommandError } from "../errors.js";
import { store } from "../store.js";
import { getVersions } from "../versions.js";
import { renderQuestion } from "./templates.js";

// The discrepancy engine: compares a confirmed document value to the application's own value with
// the tolerance the document schema states. It is called only from tasks.ts, after a reviewer
// decision or a derived value; the commands never call it, so the dependency runs one way.

export interface ToleranceResult {
  /** True when the extracted value is outside the tolerance and a question is needed. */
  outside: boolean;
  /** Absolute difference in cents and the percent of the stated value (two decimals). */
  difference: { absolute: number; percent: number };
}

/**
 * Applies a tolerance to a stated and an extracted amount, both integer cents.
 *  - `percent_or_absolute`: outside the stated value plus or minus the larger of `percent` of it
 *    and `absolute` cents (a difference exactly on the edge is inside);
 *  - `percent_over`: the stated value exceeds the extracted value by more than `percent` of the
 *    extracted value (a stated value below the extracted one is never outside).
 * `difference.percent` always uses the stated value as its denominator.
 */
export function evaluateTolerance(tolerance: Tolerance, stated: number, extracted: number): ToleranceResult {
  const absolute = Math.abs(stated - extracted);
  const percent = stated === 0 ? 0 : Math.round((absolute / Math.abs(stated)) * 10000) / 100;
  const difference = { absolute, percent };
  if (tolerance.kind === "percent_or_absolute") {
    // Scaled by 100 so the percent comparison stays in whole numbers.
    const allowed = Math.max(Math.abs(stated) * tolerance.percent, tolerance.absolute * 100);
    return { outside: absolute * 100 > allowed, difference };
  }
  return { outside: (stated - extracted) * 100 > extracted * tolerance.percent, difference };
}

/** The rule as the reviewer reads it beside the two values. */
export function ruleText(field: DocumentFieldDef, documentTitle: string): string {
  const stated = (field.compareTo ? fieldDef(field.compareTo)?.label : undefined) ?? "application value";
  const tolerance = field.tolerance;
  if (!tolerance) return "";
  if (tolerance.kind === "percent_or_absolute") {
    return `${field.label} differs from the ${stated.toLowerCase()} by more than ${tolerance.percent}% or ${formatMoney(tolerance.absolute)}, whichever is larger.`;
  }
  return `The ${stated.toLowerCase()} is more than ${tolerance.percent}% above the ${documentTitle.toLowerCase()} ${field.label.toLowerCase()}.`;
}

/** A rule id that names the field and the numbers in force. */
export function ruleIdFor(fieldKey: string, tolerance: Tolerance): string {
  return tolerance.kind === "percent_or_absolute"
    ? `${fieldKey}:${tolerance.kind}:${tolerance.percent}:${tolerance.absolute}`
    : `${fieldKey}:${tolerance.kind}:${tolerance.percent}`;
}

/**
 * Compares one confirmed (or corrected) document value to the application. Does nothing when the
 * field has no `compareTo`, when the stated value is not a typed or confirmed number yet (the
 * compare runs again on the next decision), when the value is inside the tolerance (nothing is
 * stored; the panel computes the difference on the fly) or when this value already has an open
 * record. Outside the tolerance, `raiseDiscrepancy` opens a record with the field's reason code and
 * the question rendered from its template. The question is not sent until the reviewer sends it.
 */
export function compareOnConfirm(ctx: Ctx, proposal: ProposedValue, taskId?: string): DiscrepancyRecord | null {
  const found = fieldForKey(proposal.field_key);
  const field = found?.field;
  if (!found || !field?.compareTo || !field.tolerance || !field.discrepancy_reason) return null;

  const current = store.getProposal(proposal.id);
  if (!current || (current.state !== "confirmed" && current.state !== "edited")) return null;
  if (typeof current.value !== "number") return null;

  const application = store.getApplication(current.application_id);
  const stated = application?.fields[field.compareTo];
  if (!application || !stated || typeof stated.value !== "number") return null;

  const task = taskId ? store.getReviewTask(taskId) : store.listReviewTasks(application.id)[0];
  if (!task) throw new CommandError("There is no review task to attach a difference to.", { status: 404 });

  const result = evaluateTolerance(field.tolerance, stated.value, current.value);
  if (!result.outside) return null;

  const open = store
    .listDiscrepancies(application.id)
    .some((d) => d.status === "open" && d.field_key === current.field_key && d.extracted.proposal_id === current.id);
  if (open) return null;

  const reason = field.discrepancy_reason;
  const stated_ = { value: stated.value, pointer: { kind: "form" as const, field_key: field.compareTo } };
  const extracted = { value: current.value, proposal_id: current.id };
  return raiseDiscrepancy(ctx, {
    field_key: current.field_key,
    stated: stated_,
    extracted,
    rule_id: ruleIdFor(current.field_key, field.tolerance),
    tolerance_version: getVersions().schemas,
    difference: result.difference,
    reason_code: reason,
    question: { template_id: reason, text: renderQuestion(reason, { stated: stated_, extracted }) },
    review_task_id: task.id,
  }).record;
}
