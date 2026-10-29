import type { AddressInfo } from "node:net";
import express from "express";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Box, ProposedValue } from "@shared/schemas";
import { errorHandler } from "../server/api/index.js";
import { createReviewRouter } from "../server/api/review.js";
import { enqueueExtraction } from "../server/extraction/extract.js";
import { store } from "../server/store.js";
import { ApiError } from "../web/src/errors";
import { createReviewApi, isTaskList, isTaskView } from "../web/src/review-api";
import {
  boxesOnPage,
  boxToPixels,
  canConfirm,
  canCorrect,
  canFlag,
  completeState,
  confirmRequest,
  correctionStartText,
  decisionSummary,
  defaultFlagReason,
  discrepancyStage,
  findRowForRecord,
  firstSelectable,
  formatDifference,
  formatDiscrepancyValue,
  formatRowValue,
  groupRows,
  nextUndecidedKey,
  openDiscrepancyCount,
  recalculationCaption,
  rowBox,
  rowPage,
  sourceClaim,
  tabCaption,
  waitingFor,
} from "../web/src/review-present";
import type { TaskDocumentView, TaskFieldRow, TaskView } from "../web/src/review-types";
import { loadComponent } from "./helpers/web-components";
import { APP, freshWorld, goodCaller, system } from "./helpers/world.js";

// The reviewer screen's pure parts (where a box lands, how rows group, which controls are enabled,
// how a value reads) and its API helpers, the latter against the real review routes.

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const BBOX: Box = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };

function boxProposal(over: { value?: number | string | null; page?: number | null; bbox?: Box | null; quote?: string } = {}) {
  return {
    id: "prop_1",
    application_id: APP,
    field_key: "pay_stub.gross_pay",
    value: over.value === undefined ? 235000 : over.value,
    source: {
      kind: "box",
      ref: {
        document_id: "doc_1",
        page: over.page === undefined ? 1 : over.page,
        bbox: over.bbox === undefined ? BBOX : over.bbox,
        words: [],
        quoted_text: over.quote ?? "2,350.00",
      },
    },
    match: { method: "exact" },
    state: "proposed",
  } as unknown as ProposedValue;
}

function row(over: Partial<TaskFieldRow> = {}): TaskFieldRow {
  return {
    field_key: "pay_stub.gross_pay",
    field_id: "gross_pay",
    label: "Gross pay",
    type: "money",
    description: "Gross pay for this pay period.",
    options: null,
    proposal: boxProposal(),
    status: "undecided",
    location: "located",
    error_code: null,
    actions: ["confirm", "correct", "flag"],
    requires_acknowledgement: false,
    decision: null,
    formula: null,
    compare_to: null,
    ...over,
  };
}

function document(rows: TaskFieldRow[], over: Partial<TaskDocumentView> = {}): TaskDocumentView {
  return {
    id: "doc_1",
    slot: "pay_stub",
    title: "Pay stub",
    extraction_status: "done",
    adapter: "ocr_fixture",
    file_url: "/api/documents/doc_1/file",
    flag: null,
    rows,
    ...over,
  };
}

function taskView(documents: TaskDocumentView[], over: Partial<TaskView> = {}): TaskView {
  return {
    task: { id: "task_1", application_id: APP, document_ids: ["doc_1"], status: "in_review", jsm_issue_id: "JSM-1", created_at: "2026-10-28T10:00:00.000Z" },
    application: { id: APP, status: "documents_under_review" },
    documents,
    discrepancies: [],
    decisions: [],
    undecided_count: 0,
    can_complete: true,
    texts: { not_located_caption: "caption", located_acknowledgement: "ack", flag_reasons: {} as TaskView["texts"]["flag_reasons"] },
    ...over,
  };
}

const NOT_LOCATED = row({
  field_key: "pay_stub.net_pay",
  field_id: "net_pay",
  label: "Net pay",
  proposal: boxProposal({ value: 181240, page: 1, bbox: null, quote: "1,812.40" }),
  location: "not_located",
  error_code: "extraction.source_not_located",
  requires_acknowledgement: true,
});

// ---------------------------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------------------------

describe("box geometry", () => {
  it("projects fractions of the page onto the rendered size", () => {
    expect(boxToPixels(BBOX, { width: 600, height: 800 })).toEqual({ left: 60, top: 160, width: 180, height: 40 });
  });

  it("scales with the rendered size and keeps the same place on the page", () => {
    const small = boxToPixels(BBOX, { width: 300, height: 400 });
    const large = boxToPixels(BBOX, { width: 900, height: 1200 });
    expect(large.left).toBeCloseTo(small.left * 3);
    expect(large.top).toBeCloseTo(small.top * 3);
    expect(large.width).toBeCloseTo(small.width * 3);
    expect(large.height).toBeCloseTo(small.height * 3);
  });

  it("covers the whole page for a full-page box and never returns a negative size", () => {
    expect(boxToPixels({ x: 0, y: 0, w: 1, h: 1 }, { width: 612, height: 792 })).toEqual({ left: 0, top: 0, width: 612, height: 792 });
    expect(boxToPixels({ x: 0.5, y: 0.5, w: -0.1, h: -0.1 }, { width: 100, height: 100 })).toMatchObject({ width: 0, height: 0 });
  });
});

describe("which rows get a box", () => {
  it("draws a box for a located value from the bbox the server sent", () => {
    expect(rowBox(row(), "doc_1")).toEqual({ field_key: "pay_stub.gross_pay", page: 1, bbox: BBOX });
  });

  it("never draws one for a value that was not located, not found, or calculated", () => {
    // Even if a box were present on a not-located proposal, the row's location decides.
    expect(rowBox({ ...NOT_LOCATED, proposal: boxProposal({ bbox: BBOX }) }, "doc_1")).toBeNull();
    expect(rowBox(NOT_LOCATED, "doc_1")).toBeNull();
    expect(rowBox(row({ location: "not_extracted", proposal: boxProposal({ value: null, page: null, bbox: null }) }), "doc_1")).toBeNull();
    expect(rowBox(row({ location: "derived", proposal: null }), "doc_1")).toBeNull();
  });

  it("needs both the page and the box, and the document it belongs to", () => {
    expect(rowBox(row({ proposal: boxProposal({ page: null }) }), "doc_1")).toBeNull();
    expect(rowBox(row({ proposal: boxProposal({ bbox: null }) }), "doc_1")).toBeNull();
    expect(rowBox(row(), "doc_2")).toBeNull();
  });

  it("keeps the box of a corrected or flagged value, and lists only the boxes of one page", () => {
    const edited = row({ field_key: "pay_stub.net_pay", status: "edited" });
    const second = row({ field_key: "pay_stub.ytd_gross", proposal: boxProposal({ page: 2 }) });
    const doc = document([row(), edited, second, NOT_LOCATED]);
    expect(boxesOnPage(doc, 1).map((box) => box.field_key)).toEqual(["pay_stub.gross_pay", "pay_stub.net_pay"]);
    expect(boxesOnPage(doc, 2).map((box) => box.field_key)).toEqual(["pay_stub.ytd_gross"]);
  });

  it("reads the quote and the claimed page of a value that was not located", () => {
    expect(sourceClaim(NOT_LOCATED)).toEqual({ page: 1, quote: "1,812.40" });
    expect(rowPage(NOT_LOCATED)).toBe(1);
    expect(sourceClaim(row({ proposal: null, location: "derived" }))).toBeNull();
    expect(rowPage(row({ proposal: boxProposal({ page: null }) }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

describe("row grouping and selection", () => {
  const derived = row({
    field_key: "pay_stub.annualized_income",
    field_id: "annualized_income",
    label: "Annualized income",
    location: "derived",
    status: "waiting",
    proposal: null,
    actions: [],
    formula: {
      name: "annualized_income",
      inputs: [
        { field_id: "gross_pay", field_key: "pay_stub.gross_pay", label: "Gross pay", proposal_id: "prop_1", value: 235000, state: "proposed" },
        { field_id: "pay_frequency", field_key: "pay_stub.pay_frequency", label: "Pay frequency", proposal_id: "prop_2", value: "biweekly", state: "confirmed" },
      ],
    },
  });

  it("separates the values read from the document from the calculated ones, in schema order", () => {
    const groups = groupRows([row(), NOT_LOCATED, derived]);
    expect(groups.map((g) => [g.id, g.title, g.rows.map((r) => r.field_id)])).toEqual([
      ["read", "Read from the document", ["gross_pay", "net_pay"]],
      ["calculated", "Calculated", ["annualized_income"]],
    ]);
  });

  it("needs no headings when a document has one group", () => {
    expect(groupRows([row(), NOT_LOCATED]).map((g) => g.title)).toEqual([null]);
    expect(groupRows([])).toEqual([]);
  });

  it("opens on the first value to decide, else the first row", () => {
    const decided = row({ status: "confirmed", actions: [] });
    expect(firstSelectable(document([decided, NOT_LOCATED]))).toBe("pay_stub.net_pay");
    expect(firstSelectable(document([decided]))).toBe("pay_stub.gross_pay");
    expect(firstSelectable(document([]))).toBeNull();
  });

  it("moves on to the next value to decide, wrapping to the start", () => {
    const a = row({ field_key: "a", status: "undecided" });
    const b = row({ field_key: "b", status: "confirmed", actions: [] });
    const c = row({ field_key: "c", status: "undecided" });
    expect(nextUndecidedKey([a, b, c], "a")).toBe("c");
    expect(nextUndecidedKey([a, b, c], "c")).toBe("a");
    expect(nextUndecidedKey([a, b, c], "missing")).toBe("a");
    expect(nextUndecidedKey([{ ...a, status: "confirmed" }, b, c], "c")).toBeNull();
  });

  it("names the inputs a calculated value waits for and captions each tab", () => {
    expect(waitingFor(derived)).toEqual(["Gross pay"]);
    expect(tabCaption(document([row(), NOT_LOCATED]))).toBe("2 to decide");
    expect(tabCaption(document([row({ status: "confirmed", actions: [] })]))).toBe("All decided");
    expect(tabCaption(document([], { flag: { kind: "wrong_document_type", reason_code: "wrong_document_type", text: "x" } }))).toBe("Wrong document");
    expect(tabCaption(document([], { flag: { kind: "manual_reading", reason_code: null, text: "x" } }))).toBe("Read on the page");
  });
});

describe("which controls are enabled", () => {
  it("confirms a located value at once", () => {
    expect(canConfirm(row(), false)).toBe(true);
    expect(confirmRequest(row())).toEqual({ action: "confirm" });
  });

  it("confirms a value that was not located only after the acknowledgement, and sends it", () => {
    expect(canConfirm(NOT_LOCATED, false)).toBe(false);
    expect(canConfirm(NOT_LOCATED, true)).toBe(true);
    expect(confirmRequest(NOT_LOCATED)).toEqual({ action: "confirm", located_by_reviewer: true });
  });

  it("offers nothing on a decided value and no Confirm on an empty one", () => {
    const decided = row({ status: "confirmed", actions: [] });
    expect(canConfirm(decided, true)).toBe(false);
    expect(canCorrect(decided, "$1.00")).toBe(false);
    expect(canFlag(decided, "other")).toBe(false);
    const empty = row({ location: "not_extracted", actions: ["correct", "flag"], proposal: boxProposal({ value: null }) });
    expect(canConfirm(empty, true)).toBe(false);
    expect(canCorrect(empty, "")).toBe(false);
    expect(canCorrect(empty, "  $5,000.00 ")).toBe(true);
  });

  it("offers Correct, with what it recalculates, on a decided value the income is calculated from", () => {
    const caption = "Correcting recalculates the annualized income.";
    const confirmedInput = row({ status: "confirmed", actions: ["correct"] });
    expect(canCorrect(confirmedInput, "$2,400.00")).toBe(true);
    expect(canCorrect(confirmedInput, "  ")).toBe(false);
    expect(canConfirm(confirmedInput, true)).toBe(false);
    expect(canFlag(confirmedInput, "other")).toBe(false);
    expect(recalculationCaption(confirmedInput)).toBe(caption);
    expect(recalculationCaption(row({ status: "edited", actions: ["correct"] }))).toBe(caption);
    // Nothing to warn about before the first decision, on a decided value nothing reads, or on a calculated one.
    expect(recalculationCaption(row())).toBeNull();
    expect(recalculationCaption(row({ status: "confirmed", actions: [] }))).toBeNull();
    expect(recalculationCaption(row({ status: "flagged", actions: [] }))).toBeNull();
    expect(recalculationCaption(row({ location: "derived", status: "confirmed", actions: ["flag"] }))).toBeNull();
  });

  it("prints a Correct button and the caption on a decided input, and neither on other decided values", async () => {
    const ValueList = await loadComponent("components/ValueList.tsx", "ValueList");
    const render = (rows: TaskFieldRow[]) => {
      const props = {
        doc: document(rows),
        texts: taskView([]).texts,
        selectedKey: null,
        onSelect: () => undefined,
        onDecide: async () => true,
        busy: false,
        errors: {},
        onClearError: () => undefined,
        complete: { enabled: false, caption: "" },
        onComplete: () => undefined,
        completeError: null,
      };
      return renderToStaticMarkup(h(ValueList, props));
    };
    const input = render([row({ status: "confirmed", actions: ["correct"] })]);
    expect(input).toContain(">Correct</button>");
    expect(input).toContain("Correcting recalculates the annualized income.");
    expect(input).not.toContain(">Confirm</button>");
    const other = render([row({ status: "confirmed", actions: [] })]);
    expect(other).not.toContain(">Correct</button>");
    expect(other).not.toContain("recalculates");
    const waiting = render([row()]);
    expect(waiting).toContain(">Correct</button>");
    expect(waiting).not.toContain("recalculates");
  });

  it("flags with a reason, and a value that was never found starts as missing", () => {
    const empty = row({ location: "not_extracted", actions: ["correct", "flag"], proposal: boxProposal({ value: null }) });
    expect(defaultFlagReason(empty)).toBe("missing");
    expect(canFlag(empty, defaultFlagReason(empty))).toBe(true);
    expect(defaultFlagReason(row())).toBe("");
    expect(canFlag(row(), "")).toBe(false);
    expect(canFlag(row(), "illegible")).toBe(true);
  });

  it("lets a calculated value be flagged and nothing else", () => {
    const derived = row({ location: "derived", actions: ["flag"] });
    expect(canConfirm(derived, true)).toBe(false);
    expect(canCorrect(derived, "$1.00")).toBe(false);
    expect(canFlag(derived, "other")).toBe(true);
  });
});

describe("completing the review", () => {
  it("is enabled only when no value in any document waits for a decision", () => {
    const open = taskView([document([row()])], { undecided_count: 1, can_complete: false });
    expect(completeState(open)).toEqual({ enabled: false, caption: "1 value still needs a decision." });

    const two = taskView([document([row(), NOT_LOCATED])], { undecided_count: 2, can_complete: false });
    expect(completeState(two).caption).toBe("2 values still need a decision.");

    const done = taskView([document([row({ status: "confirmed", actions: [] })])]);
    expect(completeState(done)).toEqual({ enabled: true, caption: "Every value has a decision." });
  });

  it("stays off while a row waits, even if the server's count says otherwise", () => {
    const waiting = row({ status: "waiting", proposal: null, location: "derived", actions: [] });
    expect(completeState(taskView([document([waiting])], { can_complete: true, undecided_count: 0 }))).toEqual({
      enabled: false,
      caption: "A calculated value is still waiting for its inputs.",
    });
    // A calculated value that waits is not a value to decide: the count names only what the reviewer decides.
    expect(completeState(taskView([document([row(), waiting])], { can_complete: false, undecided_count: 1 })).caption).toBe(
      "1 value still needs a decision.",
    );
  });

  it("is off once the task is complete", () => {
    const complete = taskView([document([])], { task: { ...taskView([]).task, status: "complete" }, can_complete: false });
    expect(completeState(complete)).toEqual({ enabled: false, caption: "Review complete." });
  });

  it("is on for a task whose documents all need reading by hand", () => {
    const manual = taskView([document([], { extraction_status: "failed", flag: { kind: "manual_reading", reason_code: null, text: "x" } })]);
    expect(completeState(manual).enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

describe("how values read", () => {
  it("shows money as dollars, a date spelled out and an enum as words", () => {
    expect(formatRowValue("money", 235000)).toBe("$2,350.00");
    expect(formatRowValue("date", "2026-10-18")).toBe("Oct 18, 2026");
    expect(formatRowValue("enum", "biweekly")).toBe("Biweekly");
    expect(formatRowValue("integer", 4)).toBe("4");
    expect(formatRowValue("text", "Pinecrest Harbor Logistics")).toBe("Pinecrest Harbor Logistics");
    expect(formatRowValue("money", null)).toBe("");
    expect(formatRowValue("date", "not a date")).toBe("not a date");
  });

  it("starts a correction from text the server reads back into the same value", () => {
    expect(correctionStartText("money", 235000)).toBe("$2,350.00");
    expect(correctionStartText("date", "2026-10-18")).toBe("2026-10-18");
    expect(correctionStartText("enum", "biweekly")).toBe("biweekly");
    expect(correctionStartText("money", null)).toBe("");
  });

  it("says what was decided", () => {
    const reasons = { illegible: "Illegible" };
    expect(decisionSummary(row(), reasons)).toBeNull();
    expect(decisionSummary(row({ status: "confirmed" }), reasons)).toBe("Confirmed.");
    expect(
      decisionSummary(row({ status: "confirmed", decision: { located_by_reviewer: true } as TaskFieldRow["decision"] }), reasons),
    ).toBe("Confirmed. You found it on the page.");
    expect(decisionSummary(row({ status: "edited", decision: { before: 235000 } as TaskFieldRow["decision"] }), reasons)).toBe(
      "Corrected from $2,350.00.",
    );
    expect(
      decisionSummary(row({ status: "flagged", decision: { reason_code: "illegible", note: "Smudged" } as TaskFieldRow["decision"] }), reasons),
    ).toBe("Flagged: Illegible. Smudged");
  });

  it("words a difference with the figures the record stored", () => {
    expect(formatDiscrepancyValue(8_500_000)).toBe("$85,000.00");
    expect(formatDiscrepancyValue(null)).toBe("No value");
    expect(formatDifference({ absolute: 2_390_000, percent: 28.12 })).toBe("$23,900.00 (28.12% of the application value)");
    expect(formatDifference({ absolute: 500_000, percent: 10 })).toBe("$5,000.00 (10% of the application value)");
  });
});

// ---------------------------------------------------------------------------------------------
// The API helpers, against the real review routes
// ---------------------------------------------------------------------------------------------

let base = "";
let close: () => void = () => undefined;
const seen: Array<{ method: string; path: string; session: string | undefined }> = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    seen.push({ method: req.method, path: req.path, session: req.header("x-session-id") });
    next();
  });
  app.use(createReviewRouter());
  app.use(errorHandler);
  const listener = app.listen(0);
  await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  close = () => listener.close();
});

afterAll(() => close());

let taskId = "";

beforeEach(async () => {
  freshWorld();
  await enqueueExtraction(system, store.getApplication(APP)?.document_ids ?? [], { call: goodCaller(), retry_delay_ms: 0 });
  taskId = store.listReviewTasks(APP)[0]?.id ?? "";
  seen.length = 0;
});

function rowOf(view: TaskView, key: string): TaskFieldRow {
  for (const doc of view.documents) {
    const found = doc.rows.find((r) => r.field_key === key);
    if (found) return found;
  }
  throw new Error(`no row for ${key}`);
}

function proposalOf(view: TaskView, key: string): string {
  const id = rowOf(view, key).proposal?.id;
  if (!id) throw new Error(`no proposal for ${key}`);
  return id;
}

describe("the review API helpers", () => {
  it("reads the task list and one task, sending the session id", async () => {
    const api = createReviewApi({ baseUrl: base });
    const list = await api.listTasks();
    expect(isTaskList(list)).toBe(true);
    expect(list.open_count).toBe(1);
    expect(list.tasks[0]).toMatchObject({ id: taskId, document_count: 3, undecided_count: 16 });

    const view = await api.getTask(taskId);
    expect(isTaskView(view)).toBe(true);
    expect(view.documents.map((d) => d.title)).toEqual(["Pay stub", "Project estimate", "Scope of work letter"]);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/review/tasks", `GET /api/review/tasks/${taskId}`]);
    expect(seen.every((s) => typeof s.session === "string" && s.session.length > 0)).toBe(true);
  });

  it("draws boxes only for located values: the pay stub's net pay has none, the rest are on the page", async () => {
    const view = await createReviewApi({ baseUrl: base }).getTask(taskId);
    const payStub = view.documents[0];
    if (!payStub) throw new Error("no pay stub");
    const net = payStub.rows.find((r) => r.field_id === "net_pay");
    expect(net).toMatchObject({ location: "not_located", requires_acknowledgement: true });
    expect(rowBox(net as TaskFieldRow, payStub.id)).toBeNull();
    expect(sourceClaim(net as TaskFieldRow)).toMatchObject({ page: 1, quote: "1,812.40" });

    const boxes = boxesOnPage(payStub, 1);
    expect(boxes.map((b) => b.field_key)).not.toContain("pay_stub.net_pay");
    expect(boxes.length).toBeGreaterThanOrEqual(5);
    for (const box of boxes) {
      const pixels = boxToPixels(box.bbox, { width: 612, height: 792 });
      expect(pixels.left).toBeGreaterThanOrEqual(0);
      expect(pixels.top).toBeGreaterThanOrEqual(0);
      expect(pixels.left + pixels.width).toBeLessThanOrEqual(612.0001);
      expect(pixels.top + pixels.height).toBeLessThanOrEqual(792.0001);
    }
    // The calculated row has no box and offers Flag only.
    const derived = payStub.rows.find((r) => r.field_id === "annualized_income") as TaskFieldRow;
    expect(rowBox(derived, payStub.id)).toBeNull();
    expect(waitingFor(derived)).toEqual(["Gross pay", "Pay frequency"]);
  });

  it("sends a decision with the proposal id and answers with the refreshed task", async () => {
    const api = createReviewApi({ baseUrl: base });
    const view = await api.getTask(taskId);
    const next = await api.decide(taskId, proposalOf(view, "pay_stub.gross_pay"), { action: "confirm" });
    // Gross pay feeds the income, so it can still be corrected; the screen warns what that does.
    expect(rowOf(next, "pay_stub.gross_pay")).toMatchObject({ status: "confirmed", actions: ["correct"] });
    expect(recalculationCaption(rowOf(next, "pay_stub.gross_pay"))).toBe("Correcting recalculates the annualized income.");
    expect(recalculationCaption(rowOf(next, "pay_stub.employer_name"))).toBeNull();
    expect(next.undecided_count).toBe(15);
    expect(completeState(next).enabled).toBe(false);
  });

  it("carries the server's own message when a decision is refused", async () => {
    const api = createReviewApi({ baseUrl: base });
    const view = await api.getTask(taskId);
    const net = rowOf(view, "pay_stub.net_pay");
    expect(canConfirm(net, false)).toBe(false);
    const error = await api.decide(taskId, proposalOf(view, "pay_stub.net_pay"), { action: "confirm" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toContain(view.texts.located_acknowledgement);

    const bad = await api.decide(taskId, proposalOf(view, "pay_stub.gross_pay"), { action: "correct", value: "lots" }).catch((c: unknown) => c);
    expect((bad as ApiError).status).toBe(400);
    expect((bad as ApiError).message).toBe("Gross pay is not a dollar amount.");

    const missing = await api.getTask("task_99").catch((caught: unknown) => caught);
    expect((missing as ApiError).status).toBe(404);
  });

  it("works a task end to end: not-located confirm, the calculated row, a difference, and completion", async () => {
    const api = createReviewApi({ baseUrl: base });
    let view = await api.getTask(taskId);
    const payStub = () => view.documents[0] as TaskDocumentView;

    // Everything the reviewer can confirm outright is confirmed; the not-located value needs the acknowledgement.
    for (const doc of view.documents) {
      for (const r of doc.rows) {
        if (r.status !== "undecided") continue;
        view = await api.decide(taskId, proposalOf(view, r.field_key), confirmRequest(rowOf(view, r.field_key)));
      }
    }
    expect(rowOf(view, "pay_stub.net_pay")).toMatchObject({ status: "confirmed", decision: { located_by_reviewer: true } });

    // The server computed the annualized income from the confirmed inputs; the screen only shows it.
    const income = payStub().rows.find((r) => r.field_id === "annualized_income") as TaskFieldRow;
    expect(income).toMatchObject({ status: "confirmed", actions: ["flag"], location: "derived" });
    expect(formatRowValue(income.type, income.proposal?.value ?? null)).toBe("$61,100.00");

    // $61,100 against the stated $85,000 is outside the tolerance, so a difference is open.
    expect(openDiscrepancyCount(view)).toBe(1);
    const item = view.discrepancies[0];
    if (!item) throw new Error("no discrepancy");
    expect(discrepancyStage(item.record)).toBe("draft");
    expect(formatDifference(item.record.difference)).toBe("$23,900.00 (28.12% of the application value)");
    expect(item.rule_text).not.toBe("");
    expect(findRowForRecord(view, item.record)?.row.field_key).toBe("pay_stub.annualized_income");

    // The template is sent as edited, then resolved.
    view = await api.sendQuestion(taskId, item.record.id, `${item.record.question.text} Thank you.`);
    expect(discrepancyStage((view.discrepancies[0] as TaskView["discrepancies"][number]).record)).toBe("sent");
    expect(view.discrepancies[0]?.record.question.text.endsWith("Thank you.")).toBe(true);
    view = await api.resolveDiscrepancy(taskId, item.record.id, "explained", "She has a second job.");
    expect(view.discrepancies[0]?.record).toMatchObject({ status: "resolved", resolution: "explained", note: "She has a second job." });

    // Every value has a state, so the review can be completed.
    expect(completeState(view).enabled).toBe(true);
    view = await api.completeReview(taskId);
    expect(view.task.status).toBe("complete");
    expect(completeState(view)).toEqual({ enabled: false, caption: "Review complete." });
  });

  it("serves the document as a PDF blob", async () => {
    const api = createReviewApi({ baseUrl: base });
    const view = await api.getTask(taskId);
    const blob = await api.getDocumentFile(view.documents[0]?.file_url ?? "");
    expect(blob.type).toContain("application/pdf");
    expect(Buffer.from(await blob.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    const error = await api.getDocumentFile("/api/documents/doc_99/file").catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(404);
  });
});

describe("failures before a reply exists", () => {
  it("reports a connection failure in the screen's own words", async () => {
    const api = createReviewApi({
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const error = await api.listTasks().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).retryable).toBe(true);
  });

  it("refuses a reply that is not a task view", async () => {
    const api = createReviewApi({
      fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    });
    const error = await api.getTask("task_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retryable).toBe(false);
  });

  it("refuses an error reply that is not in the server's shape", async () => {
    const api = createReviewApi({
      fetch: () => Promise.resolve(new Response("<html>bad gateway</html>", { status: 502 })),
    });
    const error = await api.getTask("task_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });
});
