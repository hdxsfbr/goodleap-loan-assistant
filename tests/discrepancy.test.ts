import { beforeEach, describe, expect, it } from "vitest";
import type { DecisionRequest, DocumentSlot, ProposedValue } from "@shared/schemas";
import { audit } from "../server/audit-log.js";
import {
  confirmValue,
  replyToDiscrepancy,
  resolveDiscrepancy,
  sendDiscrepancyQuestion,
} from "../server/commands.js";
import { deriveBanner } from "../server/domain/banner.js";
import { CommandError } from "../server/errors.js";
import { enqueueExtraction } from "../server/extraction/extract.js";
import { currentProposal, annualize } from "../server/review/derived.js";
import { compareOnConfirm, evaluateTolerance, ruleText } from "../server/review/discrepancy.js";
import { CLARIFICATION_TEMPLATE, renderQuestion } from "../server/review/templates.js";
import { applyDecision, complete, taskView } from "../server/review/tasks.js";
import { storeWriter, store } from "../server/store.js";
import { getVersions } from "../server/versions.js";
import { schemaForSlot } from "@shared/document-schemas/index";
import { APP, answerFor, contractor, freshWorld, goodCaller, reviewer, system, type WorldOptions } from "./helpers/world.js";

const INCOME = schemaForSlot("pay_stub").fields.find((f) => f.id === "annualized_income")?.tolerance;
const ESTIMATE = schemaForSlot("estimate").fields.find((f) => f.id === "total_amount")?.tolerance;

/** Submits the sample application, extracts with a good model answer and opens the review task. */
async function openTask(options: WorldOptions = {}, answers: Partial<Record<DocumentSlot, string>> = {}) {
  freshWorld(options);
  await enqueueExtraction(system, store.getApplication(APP)?.document_ids ?? [], {
    call: goodCaller(answers),
    retry_delay_ms: 0,
  });
  const task = store.listReviewTasks(APP)[0];
  if (!task) throw new Error("no review task");
  return task.id;
}

function box(key: string): ProposedValue {
  const found = currentProposal(APP, key, "box");
  if (!found) throw new Error(`no proposal for ${key}`);
  return found;
}

function decide(taskId: string, key: string, request: DecisionRequest) {
  return applyDecision(reviewer, taskId, box(key).id, request);
}

const confirm = { action: "confirm" } as const;
const records = () => store.listDiscrepancies(APP);
const raisedEvents = () => audit.list(APP).filter((e) => e.type === "discrepancy.raised");

describe("the tolerance rules", () => {
  it("raises income outside the stated value by more than 10% or $5,000, whichever is larger", () => {
    if (!INCOME) throw new Error("no income tolerance");
    // $85,000.00 stated against $61,100.00 extracted: raised. Against $80,000.00: not.
    expect(evaluateTolerance(INCOME, 8_500_000, 6_110_000).outside).toBe(true);
    expect(evaluateTolerance(INCOME, 8_500_000, 8_000_000).outside).toBe(false);
    // The band is the larger of 10% ($8,500) and $5,000, and its edge is inside.
    expect(evaluateTolerance(INCOME, 8_500_000, 7_650_000).outside).toBe(false);
    expect(evaluateTolerance(INCOME, 8_500_000, 7_649_999).outside).toBe(true);
    expect(evaluateTolerance(INCOME, 8_500_000, 9_350_000).outside).toBe(false);
    expect(evaluateTolerance(INCOME, 8_500_000, 9_350_001).outside).toBe(true);
    // On a small income $5,000 is the larger: 10% of $40,000 is only $4,000.
    expect(evaluateTolerance(INCOME, 4_000_000, 3_500_000).outside).toBe(false);
    expect(evaluateTolerance(INCOME, 4_000_000, 3_499_999).outside).toBe(true);
  });

  it("measures the difference against the stated value", () => {
    if (!INCOME) throw new Error("no income tolerance");
    expect(evaluateTolerance(INCOME, 8_500_000, 6_110_000).difference).toEqual({ absolute: 2_390_000, percent: 28.12 });
    expect(evaluateTolerance(INCOME, 6_110_000, 8_500_000).difference.percent).toBe(39.12);
  });

  it("raises a requested amount only when it is more than 5% above the estimate total", () => {
    if (!ESTIMATE) throw new Error("no estimate tolerance");
    // Requested $30,000.00 against an estimate of $31,000.00: passes. $33,000.00: raised.
    expect(evaluateTolerance(ESTIMATE, 3_000_000, 3_100_000).outside).toBe(false);
    expect(evaluateTolerance(ESTIMATE, 3_300_000, 3_100_000).outside).toBe(true);
    // 5% of $31,000.00 is $1,550.00; the edge is inside. A request below the estimate is never outside.
    expect(evaluateTolerance(ESTIMATE, 3_255_000, 3_100_000).outside).toBe(false);
    expect(evaluateTolerance(ESTIMATE, 3_255_001, 3_100_000).outside).toBe(true);
    expect(evaluateTolerance(ESTIMATE, 1_000_000, 3_100_000).outside).toBe(false);
  });

  it("states each rule as text", () => {
    const income = schemaForSlot("pay_stub").fields.find((f) => f.id === "annualized_income");
    const total = schemaForSlot("estimate").fields.find((f) => f.id === "total_amount");
    expect(ruleText(income!, "Pay stub")).toBe(
      "Annualized income differs from the stated annual income by more than 10% or $5,000.00, whichever is larger.",
    );
    expect(ruleText(total!, "Project estimate")).toBe(
      "The requested loan amount is more than 5% above the project estimate total amount.",
    );
  });
});

describe("clarification questions", () => {
  it("fills the template of the reason with the two figures through formatMoney", () => {
    const record = { stated: { value: 8_500_000 }, extracted: { value: 6_110_000 } };
    expect(renderQuestion("income_outside_tolerance", record)).toBe(
      "The application lists an annual income of $85,000.00. The pay stub we received works out to $61,100.00 a year. Could you ask the homeowner whether the application figure includes other income, and let us know?",
    );
    expect(renderQuestion("requested_amount_over_estimate", { stated: { value: 3_300_000 }, extracted: { value: 3_100_000 } })).toBe(
      "The application requests $33,000.00. The project estimate we received totals $31,000.00. Could you confirm the amount the homeowner wants to finance?",
    );
    expect(Object.keys(CLARIFICATION_TEMPLATE).sort()).toEqual(["income_outside_tolerance", "requested_amount_over_estimate"]);
    expect(() => renderQuestion("income_outside_tolerance", { stated: { value: "85000" }, extracted: { value: 1 } })).toThrow();
  });
});

describe("derived annualized income", () => {
  it("annualizes gross pay by pay frequency", () => {
    expect(annualize(235_000, "biweekly")).toBe(6_110_000);
    expect(annualize(100_000, "weekly")).toBe(5_200_000);
    expect(annualize(100_000, "semimonthly")).toBe(2_400_000);
    expect(annualize(100_000, "monthly")).toBe(1_200_000);
  });

  it("does not exist while an input is proposed, and exists once both inputs are confirmed", async () => {
    const taskId = await openTask();
    expect(currentProposal(APP, "pay_stub.annualized_income", "formula")).toBeUndefined();

    decide(taskId, "pay_stub.gross_pay", confirm);
    expect(currentProposal(APP, "pay_stub.annualized_income", "formula")).toBeUndefined();
    const waiting = taskView(taskId).documents[0]?.rows.find((r) => r.field_id === "annualized_income");
    expect(waiting).toMatchObject({ status: "waiting", proposal: null, location: "derived", actions: [] });
    expect(waiting?.formula?.inputs.map((i) => [i.field_id, i.state])).toEqual([
      ["gross_pay", "confirmed"],
      ["pay_frequency", "proposed"],
    ]);
    expect(store.getApplication(APP)?.verified.verified_annual_income).toBeNull();

    decide(taskId, "pay_stub.pay_frequency", confirm);
    const derived = currentProposal(APP, "pay_stub.annualized_income", "formula");
    expect(derived).toMatchObject({ value: 6_110_000, state: "confirmed", confirmed_by: "system", actor_id: "system" });
    expect(derived?.source).toEqual({
      kind: "formula",
      ref: { formula: "annualized_income", inputs: [box("pay_stub.gross_pay").id, box("pay_stub.pay_frequency").id] },
    });
    expect(store.getApplication(APP)?.verified).toEqual({
      verified_annual_income: 6_110_000,
      verification_source: "document_review",
    });
    // Flag is the only action left on a derived row.
    const row = taskView(taskId).documents[0]?.rows.find((r) => r.field_id === "annualized_income");
    expect(row).toMatchObject({ status: "confirmed", actions: ["flag"] });
  });

  it("recomputes after editValue on an input and compares the new value", async () => {
    // The pay frequency was not found: the derived row exists, flagged, from the moment the task opens.
    const taskId = await openTask({}, { pay_stub: answerFor("pay_stub", { pay_frequency: null }) });
    const flagged = currentProposal(APP, "pay_stub.annualized_income", "formula");
    expect(flagged).toMatchObject({ value: null, state: "rejected", reason_code: "pay_frequency_not_located" });
    expect(records()).toHaveLength(0);

    // Still missing after the gross pay is confirmed: the flagged row stays.
    decide(taskId, "pay_stub.gross_pay", confirm);
    expect(taskView(taskId).documents[0]?.rows.find((r) => r.field_id === "annualized_income")).toMatchObject({
      status: "flagged",
    });
    decide(taskId, "pay_stub.pay_frequency", { action: "correct", value: "Every two weeks" });

    const derived = currentProposal(APP, "pay_stub.annualized_income", "formula");
    expect(derived).toMatchObject({ value: 6_110_000, state: "confirmed" });
    expect(derived?.id).not.toBe(flagged?.id);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ reason_code: "income_outside_tolerance", extracted: { proposal_id: derived?.id } });
  });

  it("waits, with no flag, once the missing frequency is corrected and the gross pay is still proposed", async () => {
    const taskId = await openTask({}, { pay_stub: answerFor("pay_stub", { pay_frequency: null }) });
    decide(taskId, "pay_stub.pay_frequency", { action: "correct", value: "Biweekly" });
    expect(taskView(taskId).documents[0]?.rows.find((r) => r.field_id === "annualized_income")).toMatchObject({
      status: "waiting",
      proposal: null,
    });
    decide(taskId, "pay_stub.gross_pay", confirm);
    expect(currentProposal(APP, "pay_stub.annualized_income", "formula")).toMatchObject({ value: 6_110_000, state: "confirmed" });
  });

  it("recomputes a corrected gross pay inside the tolerance without raising anything", async () => {
    const taskId = await openTask();
    decide(taskId, "pay_stub.pay_frequency", confirm);
    // $3,076.92 x 26 = $79,999.92, within $8,500.00 of the stated $85,000.00.
    decide(taskId, "pay_stub.gross_pay", { action: "correct", value: "$3,076.92" });
    expect(currentProposal(APP, "pay_stub.annualized_income", "formula")).toMatchObject({ value: 7_999_992, state: "confirmed" });
    expect(store.getApplication(APP)?.verified.verified_annual_income).toBe(7_999_992);
    expect(records()).toHaveLength(0);
    expect(raisedEvents()).toHaveLength(0);
  });

  it("yields a rejected formula row when the frequency is flagged, and source_not_located when the gross pay is", async () => {
    const taskId = await openTask();
    decide(taskId, "pay_stub.gross_pay", confirm);
    decide(taskId, "pay_stub.pay_frequency", { action: "flag", reason_code: "illegible" });
    expect(currentProposal(APP, "pay_stub.annualized_income", "formula")).toMatchObject({
      value: null,
      state: "rejected",
      reason_code: "pay_frequency_not_located",
    });
    expect(store.getApplication(APP)?.verified.verified_annual_income).toBeNull();
    expect(records()).toHaveLength(0);
    expect(taskView(taskId).documents[0]?.rows.find((r) => r.field_id === "annualized_income")).toMatchObject({
      status: "flagged",
      location: "derived",
      actions: [],
    });

    const other = await openTask();
    decide(other, "pay_stub.gross_pay", { action: "flag", reason_code: "illegible" });
    expect(currentProposal(APP, "pay_stub.annualized_income", "formula")).toMatchObject({
      state: "rejected",
      reason_code: "source_not_located",
    });
  });

  it("accepts flag and nothing else on a derived value", async () => {
    const taskId = await openTask();
    decide(taskId, "pay_stub.gross_pay", confirm);
    decide(taskId, "pay_stub.pay_frequency", confirm);
    const derived = currentProposal(APP, "pay_stub.annualized_income", "formula");
    expect(() => applyDecision(reviewer, taskId, derived?.id ?? "", confirm)).toThrow(CommandError);
    expect(() => applyDecision(reviewer, taskId, derived?.id ?? "", { action: "correct", value: 1 })).toThrow(CommandError);

    applyDecision(reviewer, taskId, derived?.id ?? "", { action: "flag", reason_code: "mismatch_with_stated" });
    const flagged = currentProposal(APP, "pay_stub.annualized_income", "formula");
    expect(flagged).toMatchObject({ state: "rejected", reason_code: "mismatch_with_stated", value: null });
    expect(store.getProposal(derived?.id ?? "")?.state).toBe("superseded");
  });
});

/** Confirms every value of the task that still waits, with the acknowledgement where one is needed. */
function confirmTheRest(taskId: string): void {
  for (const row of taskView(taskId).documents.flatMap((d) => d.rows)) {
    if (row.proposal?.state !== "proposed" || !row.actions.includes("confirm")) continue;
    applyDecision(reviewer, taskId, row.proposal.id, {
      action: "confirm",
      ...(row.requires_acknowledgement ? { located_by_reviewer: true } : {}),
    });
  }
}

const NO_VERIFIED_INCOME = { verified_annual_income: null, verification_source: null };

describe("a flagged calculated value is no longer verified", () => {
  it("clears the stored income when the confirmed annualized income is flagged, and the review completes without it", async () => {
    const taskId = await openTask();
    decide(taskId, "pay_stub.gross_pay", confirm);
    decide(taskId, "pay_stub.pay_frequency", confirm);
    const confirmed = currentProposal(APP, "pay_stub.annualized_income", "formula")!;
    expect(store.getApplication(APP)?.verified).toEqual({
      verified_annual_income: 6_110_000,
      verification_source: "document_review",
    });

    applyDecision(reviewer, taskId, confirmed.id, { action: "flag", reason_code: "mismatch_with_stated" });

    expect(store.getApplication(APP)?.verified).toEqual(NO_VERIFIED_INCOME);
    expect(store.getProposal(confirmed.id)?.state).toBe("superseded");
    expect(currentProposal(APP, "pay_stub.annualized_income", "formula")).toMatchObject({
      state: "rejected",
      value: null,
      reason_code: "mismatch_with_stated",
    });
    // The system's withdrawal is on the trail, on the proposal that had been verified, before the reviewer's flag.
    const rejections = audit
      .list(APP)
      .filter((e) => e.type === "field.rejected" && e.field_key === "pay_stub.annualized_income");
    expect(rejections.map((e) => [e.actor.type, e.type === "field.rejected" && e.proposal_id === confirmed.id])).toEqual([
      ["system", true],
      ["reviewer", false],
    ]);
    expect(rejections[0]).toMatchObject({ review_task_id: taskId, reason_code: "mismatch_with_stated" });

    confirmTheRest(taskId);
    complete(reviewer, taskId);
    expect(store.getApplication(APP)?.status).toBe("documents_reviewed");
    expect(store.getApplication(APP)?.verified).toEqual(NO_VERIFIED_INCOME);
  });
});

describe("correcting a value that was already decided", () => {
  const derivedKey = "pay_stub.annualized_income";
  const verifiedIncome = () => store.getApplication(APP)?.verified.verified_annual_income;

  async function bothInputsConfirmed() {
    const taskId = await openTask();
    decide(taskId, "pay_stub.gross_pay", confirm);
    decide(taskId, "pay_stub.pay_frequency", confirm);
    const first = currentProposal(APP, derivedKey, "formula")!;
    expect(first).toMatchObject({ value: 6_110_000, state: "confirmed" });
    return { taskId, first };
  }

  it("recomputes the income from a corrected gross pay: a new derived proposal, the old verification withdrawn, the new one stored", async () => {
    const { taskId, first } = await bothInputsConfirmed();
    const decidedGross = box("pay_stub.gross_pay");
    expect(decidedGross.state).toBe("confirmed");

    const view = decide(taskId, "pay_stub.gross_pay", { action: "correct", value: "$2,400.00" });

    const corrected = box("pay_stub.gross_pay");
    expect(corrected).toMatchObject({ value: 240_000, state: "edited" });
    expect(corrected.id).not.toBe(decidedGross.id);
    expect(corrected.source).toEqual(decidedGross.source);
    const second = currentProposal(APP, derivedKey, "formula")!;
    expect(second).toMatchObject({ value: 6_240_000, state: "confirmed", confirmed_by: "system" });
    expect(second.id).not.toBe(first.id);
    expect(second.source).toEqual({
      kind: "formula",
      ref: { formula: "annualized_income", inputs: [corrected.id, box("pay_stub.pay_frequency").id] },
    });
    expect(store.getProposal(first.id)?.state).toBe("superseded");
    expect(store.getApplication(APP)?.verified).toEqual({
      verified_annual_income: 6_240_000,
      verification_source: "document_review",
    });

    // The first verification was withdrawn before the new value was confirmed.
    const trail = audit.list(APP);
    const withdrawn = trail.find((e) => e.type === "field.rejected" && e.proposal_id === first.id);
    const reconfirmed = trail.find((e) => e.type === "field.confirmed" && e.proposal_id === second.id);
    expect(withdrawn).toMatchObject({ actor: { type: "system" }, review_task_id: taskId });
    expect(withdrawn && reconfirmed && withdrawn.seq < reconfirmed.seq).toBe(true);

    // The new value is compared, and the screen shows the correction as the reviewer's decision.
    expect(records().at(-1)).toMatchObject({
      field_key: derivedKey,
      status: "open",
      extracted: { value: 6_240_000, proposal_id: second.id },
    });
    const row = view.documents[0]?.rows.find((r) => r.field_id === "gross_pay");
    expect(row).toMatchObject({ status: "edited", actions: ["correct"], decision: { action: "correct", before: 235_000, value: 240_000 } });
    expect(view.documents[0]?.rows.find((r) => r.field_id === "annualized_income")?.proposal?.id).toBe(second.id);
    // The correction replaces a decided value and adds nothing that waits: 16 values, 2 decided.
    expect(view.undecided_count).toBe(14);
  });

  it("recomputes from a corrected pay frequency, and a correction inside the tolerance raises nothing new", async () => {
    const { taskId, first } = await bothInputsConfirmed();
    const before = records().length;
    // $2,350.00 a month is $28,200.00 a year; a correction back to biweekly is the original again.
    decide(taskId, "pay_stub.pay_frequency", { action: "correct", value: "Monthly" });
    expect(currentProposal(APP, derivedKey, "formula")).toMatchObject({ value: 2_820_000, state: "confirmed" });
    expect(verifiedIncome()).toBe(2_820_000);

    // Corrected twice: the second correction replaces the first, and only the newest input counts.
    decide(taskId, "pay_stub.pay_frequency", { action: "correct", value: "Biweekly" });
    decide(taskId, "pay_stub.gross_pay", { action: "correct", value: "$3,076.92" });
    const last = currentProposal(APP, derivedKey, "formula")!;
    expect(last).toMatchObject({ value: 7_999_992, state: "confirmed" });
    expect(last.id).not.toBe(first.id);
    expect(verifiedIncome()).toBe(7_999_992);
    // Inside the band of $85,000.00: no record for the last value.
    expect(records().some((r) => r.extracted.proposal_id === last.id)).toBe(false);
    expect(records().length).toBeGreaterThanOrEqual(before);
  });

  it("refuses everything else on a decided value: a second confirm, a flag, a stale proposal, or a field no formula reads", async () => {
    const { taskId } = await bothInputsConfirmed();
    const decidedGross = box("pay_stub.gross_pay");
    expect(() => applyDecision(reviewer, taskId, decidedGross.id, confirm)).toThrow(/already has a decision/);
    expect(() => applyDecision(reviewer, taskId, decidedGross.id, { action: "flag", reason_code: "illegible" })).toThrow(
      /already has a decision/,
    );
    expect(verifiedIncome()).toBe(6_110_000);

    decide(taskId, "pay_stub.employer_name", confirm);
    expect(() => decide(taskId, "pay_stub.employer_name", { action: "correct", value: "Someone Else" })).toThrow(
      /already has a decision/,
    );

    // A correction replaces the decided proposal; the replaced one cannot be corrected again.
    decide(taskId, "pay_stub.gross_pay", { action: "correct", value: "$2,400.00" });
    expect(() => applyDecision(reviewer, taskId, decidedGross.id, { action: "correct", value: "$2,500.00" })).toThrow(
      CommandError,
    );
    expect(currentProposal(APP, derivedKey, "formula")).toMatchObject({ value: 6_240_000 });

    // A value that does not parse is refused before anything changes.
    const events = audit.list(APP).length;
    expect(() => decide(taskId, "pay_stub.gross_pay", { action: "correct", value: "lots" })).toThrow(CommandError);
    expect(audit.list(APP)).toHaveLength(events);
  });

  it("leaves the stored income as it was when the correction cannot be read", async () => {
    const { taskId } = await bothInputsConfirmed();
    expect(() => decide(taskId, "pay_stub.pay_frequency", { action: "correct", value: "whenever" })).toThrow(CommandError);
    expect(verifiedIncome()).toBe(6_110_000);
    expect(currentProposal(APP, derivedKey, "formula")).toMatchObject({ value: 6_110_000, state: "confirmed" });
  });
});

describe("raising a discrepancy", () => {
  it("opens an income record with both values and pointers, the difference, the rule and the question", async () => {
    const taskId = await openTask();
    decide(taskId, "pay_stub.gross_pay", confirm);
    decide(taskId, "pay_stub.pay_frequency", confirm);

    const [record] = records();
    const derived = currentProposal(APP, "pay_stub.annualized_income", "formula");
    expect(records()).toHaveLength(1);
    expect(record).toMatchObject({
      application_id: APP,
      field_key: "pay_stub.annualized_income",
      reason_code: "income_outside_tolerance",
      status: "open",
      review_task_id: taskId,
      stated: { value: 8_500_000, pointer: { kind: "form", field_key: "stated_annual_income" } },
      extracted: { value: 6_110_000, proposal_id: derived?.id },
      difference: { absolute: 2_390_000, percent: 28.12 },
      tolerance_version: getVersions().schemas,
      question: { template_id: "income_outside_tolerance" },
    });
    expect(record?.rule_id).toBe("pay_stub.annualized_income:percent_or_absolute:10:500000");
    expect(record?.question.text).toBe(
      renderQuestion("income_outside_tolerance", { stated: { value: 8_500_000 }, extracted: { value: 6_110_000 } }),
    );
    expect(record?.sent_at).toBeUndefined();
    // The view the screen renders holds nothing JSON cannot carry, undefined included.
    const rendered = taskView(taskId);
    expect(JSON.parse(JSON.stringify(rendered))).toStrictEqual(rendered);
    expect(rendered.discrepancies[0]).toMatchObject({
      rule_text: ruleText(schemaForSlot("pay_stub").fields[7]!, "Pay stub"),
      field_label: "Annualized income",
      stated_label: "Stated annual income",
    });

    // The order of events: the reviewer's decisions, then the system's value, then the record.
    const types = audit.list(APP).map((e) => `${e.actor.type}:${e.type}`);
    const tail = types.slice(types.indexOf("system:field.proposed"));
    expect(tail).toEqual(["system:field.proposed", "system:field.confirmed", "system:discrepancy.raised"]);
  });

  it("raises the requested-amount record only above 5% over the estimate total", async () => {
    const calm = await openTask();
    decide(calm, "estimate.total_amount", confirm);
    expect(records()).toHaveLength(0);

    const taskId = await openTask({ requested: 3_300_000 });
    decide(taskId, "estimate.total_amount", confirm);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      field_key: "estimate.total_amount",
      reason_code: "requested_amount_over_estimate",
      stated: { value: 3_300_000, pointer: { kind: "form", field_key: "requested_loan_amount" } },
      extracted: { value: 3_100_000 },
      difference: { absolute: 200_000, percent: 6.06 },
    });
    expect(records()[0]?.question.text).toContain("$33,000.00");
    expect(records()[0]?.question.text).toContain("$31,000.00");
  });

  it("compares a corrected total, not the model's", async () => {
    const taskId = await openTask({ requested: 3_300_000 });
    decide(taskId, "estimate.total_amount", { action: "correct", value: "$33,000.00" });
    expect(records()).toHaveLength(0);
    const other = await openTask({ requested: 3_300_000 });
    decide(other, "estimate.total_amount", { action: "correct", value: "$30,000.00" });
    expect(records()).toHaveLength(1);
    expect(records()[0]?.extracted.value).toBe(3_000_000);
  });

  it("does not compare a flagged value or a value with no compareTo", async () => {
    const taskId = await openTask({ requested: 3_300_000 });
    decide(taskId, "estimate.total_amount", { action: "flag", reason_code: "illegible" });
    decide(taskId, "estimate.contractor_name", confirm);
    expect(records()).toHaveLength(0);
    expect(compareOnConfirm(system, store.getProposal(box("estimate.contractor_name").id)!, taskId)).toBeNull();
  });

  it("raises nothing when the stated value is absent", async () => {
    const taskId = await openTask();
    delete storeWriter().applications.get(APP)?.fields.stated_annual_income;
    decide(taskId, "pay_stub.gross_pay", confirm);
    decide(taskId, "pay_stub.pay_frequency", confirm);
    expect(currentProposal(APP, "pay_stub.annualized_income", "formula")?.state).toBe("confirmed");
    expect(records()).toHaveLength(0);
  });

  it("does not raise the same difference twice", async () => {
    const taskId = await openTask();
    decide(taskId, "pay_stub.gross_pay", confirm);
    decide(taskId, "pay_stub.pay_frequency", confirm);
    const derived = currentProposal(APP, "pay_stub.annualized_income", "formula")!;
    expect(compareOnConfirm(system, derived, taskId)).toBeNull();
    expect(records()).toHaveLength(1);
  });

  it("leaves the commands out of it: confirmValue alone emits no discrepancy.raised", async () => {
    const taskId = await openTask({ requested: 3_300_000 });
    for (const key of ["pay_stub.gross_pay", "pay_stub.pay_frequency", "estimate.total_amount"]) {
      confirmValue(reviewer, box(key).id, { review_task_id: taskId });
    }
    expect(raisedEvents()).toHaveLength(0);
    expect(records()).toHaveLength(0);
    expect(currentProposal(APP, "pay_stub.annualized_income", "formula")).toBeUndefined();
  });
});

describe("the banner and the record lifecycle", () => {
  async function twoRecords() {
    const taskId = await openTask({ requested: 3_300_000 });
    decide(taskId, "pay_stub.gross_pay", confirm);
    decide(taskId, "pay_stub.pay_frequency", confirm);
    decide(taskId, "estimate.total_amount", confirm);
    const [income, amount] = records();
    if (!income || !amount) throw new Error("expected two records");
    return { taskId, income, amount };
  }

  it("is null until a question is sent, and set while any sent record is open", async () => {
    const { income, amount } = await twoRecords();
    expect(deriveBanner(records())).toBeNull();

    sendDiscrepancyQuestion(reviewer, income.id, "Does the stated income include a second job?");
    sendDiscrepancyQuestion(reviewer, amount.id, "Please confirm the amount to finance.");
    expect(deriveBanner(records())).toMatchObject({ record_id: income.id, question: "Does the stated income include a second job?" });

    resolveDiscrepancy(reviewer, income.id, { resolution: "explained", note: "A second job accounts for it." });
    expect(deriveBanner(records())).toMatchObject({ record_id: amount.id });

    resolveDiscrepancy(reviewer, amount.id, { resolution: "corrected", note: "Contractor confirmed $31,000.00." });
    expect(deriveBanner(records())).toBeNull();
  });

  it("routes the question to the contractor, shows the reply and records how it was resolved", async () => {
    const { taskId, income } = await twoRecords();
    expect(() => resolveDiscrepancy(reviewer, income.id, { resolution: "explained", note: "x" })).toThrow(/Send the question/);

    sendDiscrepancyQuestion(reviewer, income.id, "Does the stated income include a second job?");
    expect(store.getDiscrepancy(income.id)?.sent_at).toBeDefined();
    replyToDiscrepancy(contractor, income.id, "She also has a second job; the stated income includes both.");
    expect(deriveBanner(records())?.contractor_reply).toBe("She also has a second job; the stated income includes both.");
    expect(taskView(taskId).discrepancies.find((d) => d.record.id === income.id)?.record.contractor_reply?.text).toContain("second job");

    resolveDiscrepancy(reviewer, income.id, { resolution: "explained", note: "Second job confirmed in the reply." });
    expect(store.getDiscrepancy(income.id)).toMatchObject({
      status: "resolved",
      resolution: "explained",
      resolver: "rev_demo_001",
      note: "Second job confirmed in the reply.",
    });
    // The stored status does not move: no verdict, no state change beyond the review.
    expect(store.getApplication(APP)?.status).toBe("documents_under_review");
  });

  it("records a correction in the note", async () => {
    const { amount } = await twoRecords();
    sendDiscrepancyQuestion(reviewer, amount.id, "Please confirm the amount to finance.");
    replyToDiscrepancy(contractor, amount.id, "The right figure is $31,000.00.");
    resolveDiscrepancy(reviewer, amount.id, { resolution: "corrected", note: "Corrected figure: $31,000.00." });
    expect(store.getDiscrepancy(amount.id)).toMatchObject({ resolution: "corrected", note: "Corrected figure: $31,000.00." });
    expect(() => resolveDiscrepancy(reviewer, amount.id, { resolution: "explained", note: "again" })).toThrow(CommandError);
  });
});
