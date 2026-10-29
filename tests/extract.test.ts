import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachDocument, completeReview, submitApplication } from "../server/commands.js";
import { audit } from "../server/audit-log.js";
import { AppError } from "../server/errors.js";
import { ocrPathFor, readOcrFixture } from "../server/extraction/adapters/ocr-fixture.js";
import { enqueueExtraction, extractDocument, openReviewTask, startDocumentReview } from "../server/extraction/extract.js";
import type { PositionedText } from "../server/extraction/positioned-text.js";
import { taskView } from "../server/review/tasks.js";
import type { ModelCaller } from "../server/extraction/llm.js";
import { services } from "../server/services/index.js";
import { store } from "../server/store.js";
import { APP, answerFor, contractor, freshWorld, goodCaller, scriptedCaller, system, type World } from "./helpers/world.js";

// The extraction consumer driven by a stand-in for the model, so no key is needed. The recorded
// real answers are replayed in fixture-replay.test.ts.

let world: World;

beforeEach(() => {
  world = freshWorld();
});

afterEach(() => vi.unstubAllEnvs());

const fast = { retry_delay_ms: 0 };

function ids(): string[] {
  return store.getApplication(APP)?.document_ids ?? [];
}

function proposalFor(key: string) {
  return store.listProposals(APP).find((p) => p.field_key === key);
}

function eventsOf(type: string) {
  return audit.list(APP).filter((e) => e.type === type);
}

describe("extraction with a good answer", () => {
  it("records one proposal per model field, with boxes from the document's own words", async () => {
    await enqueueExtraction(system, ids(), { call: goodCaller(), ...fast });

    expect(store.listDocuments(APP).map((d) => d.extraction_status)).toEqual(["done", "done", "done"]);
    // 7 pay stub fields (annualized income is derived), 5 estimate fields, 4 scope letter fields.
    expect(store.listProposals(APP)).toHaveLength(16);

    const gross = proposalFor("pay_stub.gross_pay");
    expect(gross).toMatchObject({ value: 235000, state: "proposed", actor_id: "scripted-model" });
    expect(gross?.match).toEqual({ method: "exact" });
    expect(gross?.source.kind).toBe("box");
    if (gross?.source.kind === "box") {
      expect(gross.source.ref.page).toBe(1);
      expect(gross.source.ref.quoted_text).toBe("2,350.00");
      expect(gross.source.ref.words).toHaveLength(1);
      expect(gross.source.ref.words[0]).toMatchObject({ text: "2,350.00", page: 1, line: 7, token: 2 });
      const box = gross.source.ref.bbox;
      expect(box).not.toBeNull();
      expect(box?.x).toBeGreaterThan(0);
      expect((box?.x ?? 0) + (box?.w ?? 0)).toBeLessThanOrEqual(1);
      expect((box?.y ?? 0) + (box?.h ?? 0)).toBeLessThanOrEqual(1);
    }

    expect(proposalFor("pay_stub.pay_frequency")?.value).toBe("biweekly");
    expect(proposalFor("pay_stub.pay_period_start")?.value).toBe("2026-10-05");
    expect(proposalFor("estimate.total_amount")?.value).toBe(3100000);
    expect(proposalFor("estimate.line_item_count")?.value).toBe(4);
    expect(proposalFor("scope_letter.start_date")?.value).toBe("2026-11-09");
    expect(proposalFor("pay_stub.annualized_income")).toBeUndefined();
  });

  it("leaves the net pay figure not located: the quote verified but its words have no geometry", async () => {
    await enqueueExtraction(system, ids(), { call: goodCaller(), ...fast });
    const net = proposalFor("pay_stub.net_pay");
    expect(net?.value).toBe(181240);
    expect(net?.match).toEqual({ method: "not_located" });
    expect(net?.source.kind === "box" && net.source.ref.bbox).toBeNull();
    expect(net?.source.kind === "box" && net.source.ref.words.map((w) => w.text)).toEqual(["1,812.40"]);
    expect(net?.source.kind === "box" && net.source.ref.quoted_text).toBe("1,812.40");
    expect(taskView(store.listReviewTasks(APP)[0]?.id ?? "").documents[0]?.rows.find((r) => r.field_id === "net_pay")).toMatchObject({
      location: "not_located",
      error_code: "extraction.source_not_located",
      requires_acknowledgement: true,
      actions: ["confirm", "correct", "flag"],
    });
  });

  it("appends the audit trail: model events from the model, completion per document, then the task", async () => {
    await enqueueExtraction(system, ids(), { call: goodCaller(), ...fast });
    const completed = eventsOf("extraction.completed");
    expect(completed).toHaveLength(3);
    expect(completed[0]).toMatchObject({ extraction_status: "done" });
    expect((completed[0] as { per_field: unknown[] }).per_field).toHaveLength(7);
    expect(eventsOf("document.attached")).toHaveLength(3);
    // The proposals carry the model call that produced them.
    const proposed = eventsOf("field.proposed");
    expect(proposed).toHaveLength(16);
    expect(proposed.every((e) => e.actor.type === "model" && e.parent_event_id === "evt_scripted")).toBe(true);

    const types = audit.list(APP).map((e) => e.type);
    expect(types.lastIndexOf("extraction.completed")).toBeLessThan(types.indexOf("review.task_created"));

    // The documents service served the two text PDFs; the review queue was called through the mock envelope.
    const calls = eventsOf("tool.call") as Array<{ service: string; method: string; _mock?: unknown }>;
    expect(calls.filter((c) => c.service === "documents" && c.method === "getFile")).toHaveLength(2);
    expect(calls.filter((c) => c.service === "review_queue").map((c) => c.method)).toEqual(["createIssue", "addLink"]);
    expect(calls.every((c) => c._mock !== undefined)).toBe(true);
    const [task] = store.listReviewTasks(APP);
    expect(task?.status).toBe("ready");
    expect(task?.jsm_issue_id).toMatch(/^REV-\d+$/);
  });
});

describe("what the model gets wrong", () => {
  it("turns a document of the wrong type into type_mismatch with no proposals and a flag", async () => {
    const mismatch = JSON.stringify({
      document_matches_slot: false,
      fields: Object.fromEntries(Object.keys(JSON.parse(answerFor("estimate")).fields).map((id) => [id, null])),
    });
    await enqueueExtraction(system, ids(), { call: goodCaller({ estimate: mismatch }), ...fast });

    const estimate = world.docs.estimate;
    expect(store.getDocument(estimate?.id ?? "")?.extraction_status).toBe("type_mismatch");
    expect(store.listProposals(APP).some((p) => p.field_key.startsWith("estimate."))).toBe(false);
    const done = eventsOf("extraction.completed").find((e) => e.type === "extraction.completed" && e.document_id === estimate?.id);
    expect(done).toMatchObject({ extraction_status: "type_mismatch", error_code: "extraction.document_type_mismatch" });

    const view = taskView(store.listReviewTasks(APP)[0]?.id ?? "");
    const doc = view.documents.find((d) => d.slot === "estimate");
    expect(doc?.flag).toMatchObject({ kind: "wrong_document_type", reason_code: "wrong_document_type" });
    expect(doc?.rows).toEqual([]);
    expect(store.listReviewTasks(APP)[0]?.status).toBe("ready");
  });

  it("retries once on a timeout, a rate limit, a server error or an invalid answer", async () => {
    for (const first of [
      new AppError("llm.timeout"),
      new AppError("llm.rate_limited"),
      new AppError("llm.server_error"),
      "this is not JSON",
      JSON.stringify({ document_matches_slot: true, fields: {} }),
    ]) {
      const w = freshWorld({ slots: ["scope_letter"] });
      const calls = { count: 0 };
      const outcome = await extractDocument(system, w.docs.scope_letter?.id ?? "", {
        call: scriptedCaller([first, answerFor("scope_letter")], calls),
        ...fast,
      });
      expect(calls.count).toBe(2);
      expect(outcome.extraction_status).toBe("done");
    }
  });

  it("fails the document after a second failure and flags the slot for manual reading", async () => {
    const calls = { count: 0 };
    const outcome = await extractDocument(system, world.docs.scope_letter?.id ?? "", {
      call: scriptedCaller(["not JSON", "still not JSON"], calls),
      ...fast,
    });
    expect(calls.count).toBe(2);
    expect(outcome).toMatchObject({ extraction_status: "failed", error_code: "llm.schema_invalid" });
    expect(store.listProposals(APP)).toEqual([]);
    expect(eventsOf("extraction.completed")[0]).toMatchObject({ extraction_status: "failed", error_code: "llm.schema_invalid" });

    const timeouts = freshWorld({ slots: ["scope_letter"] });
    const twice = await extractDocument(system, timeouts.docs.scope_letter?.id ?? "", {
      call: scriptedCaller([new AppError("llm.timeout")]),
      ...fast,
    });
    expect(twice).toMatchObject({ extraction_status: "failed", error_code: "llm.timeout" });
  });

  it("does not retry a refusal or a rejected key", async () => {
    for (const code of ["llm.refusal", "llm.auth_failed", "llm.missing_key"] as const) {
      const w = freshWorld({ slots: ["scope_letter"] });
      const calls = { count: 0 };
      const outcome = await extractDocument(system, w.docs.scope_letter?.id ?? "", {
        call: scriptedCaller([new AppError(code)], calls),
        ...fast,
      });
      expect(calls.count).toBe(1);
      expect(outcome).toMatchObject({ extraction_status: "failed", error_code: code });
    }
  });

  it("opens an extraction_failed task when every slot failed, and it can be completed at once", async () => {
    await enqueueExtraction(system, ids(), { call: scriptedCaller([new AppError("llm.refusal")]), ...fast });
    const [task] = store.listReviewTasks(APP);
    expect(task?.status).toBe("extraction_failed");
    expect(store.listProposals(APP)).toEqual([]);
    const view = taskView(task?.id ?? "");
    expect(view.can_complete).toBe(true);
    expect(view.documents.every((d) => d.flag?.kind === "manual_reading")).toBe(true);
    completeReview(system, task?.id ?? "");
    expect(store.getApplication(APP)?.status).toBe("documents_reviewed");
  });

  it("keeps the task ready when only some slots failed", async () => {
    await enqueueExtraction(system, ids(), {
      call: goodCaller({ estimate: new AppError("llm.refusal") }),
      ...fast,
    });
    expect(store.listReviewTasks(APP)[0]?.status).toBe("ready");
    expect(store.listDocuments(APP).map((d) => d.extraction_status)).toEqual(["done", "failed", "done"]);
  });

  it("turns a value that does not parse into an empty row, not a guess", async () => {
    const answer = answerFor("pay_stub", {
      gross_pay: { value: "about 2,350", line: 7, start: 2, end: 2, quote: "2,350.00" },
    });
    const outcome = await extractDocument(system, world.docs.pay_stub?.id ?? "", { call: goodCaller({ pay_stub: answer }), ...fast });
    const gross = proposalFor("pay_stub.gross_pay");
    expect(gross).toMatchObject({ value: null, match: { method: "not_extracted" } });
    expect(outcome.fields.find((f) => f.field_key === "pay_stub.gross_pay")?.parse_error).toMatch(/dollar amount/);

    // The completion event keeps the reason: the field is not_extracted and says why.
    const done = eventsOf("extraction.completed")[0] as { per_field: Array<Record<string, unknown>> };
    expect(done.per_field.find((f) => f.field_key === "pay_stub.gross_pay")).toEqual({
      field_key: "pay_stub.gross_pay",
      match_method: "not_extracted",
      adapter: "ocr_fixture",
      parse_error: "Gross pay is not a dollar amount.",
    });
    // A field that read cleanly carries no diagnostics.
    expect(done.per_field.find((f) => f.field_key === "pay_stub.net_pay")).toEqual({
      field_key: "pay_stub.net_pay",
      match_method: "not_located",
      adapter: "ocr_fixture",
    });
  });

  it("keeps the quoted text of a pointer that does not contain the value, as not located", async () => {
    const answer = answerFor("pay_stub", {
      gross_pay: { value: "2,350.00", line: 7, start: 2, end: 2, quote: "214.30" },
    });
    const outcome = await extractDocument(system, world.docs.pay_stub?.id ?? "", { call: goodCaller({ pay_stub: answer }), ...fast });
    const gross = proposalFor("pay_stub.gross_pay");
    expect(gross?.match).toEqual({ method: "not_located", rejected_pointer: true });
    expect(gross?.source.kind === "box" && gross.source.ref.quoted_text).toBe("214.30");
    expect(gross?.source.kind === "box" && gross.source.ref.words).toEqual([]);
    expect(outcome.fields.find((f) => f.field_key === "pay_stub.gross_pay")?.rejected_pointer).toBe(true);
    const done = eventsOf("extraction.completed")[0] as { per_field: Array<Record<string, unknown>> };
    expect(done.per_field.find((f) => f.field_key === "pay_stub.gross_pay")).toEqual({
      field_key: "pay_stub.gross_pay",
      match_method: "not_located",
      adapter: "ocr_fixture",
      rejected_pointer: true,
    });
  });

  it("records a field the model returned as null as a row to fill in", async () => {
    const answer = answerFor("pay_stub", { ytd_gross: null });
    await extractDocument(system, world.docs.pay_stub?.id ?? "", { call: goodCaller({ pay_stub: answer }), ...fast });
    const ytd = proposalFor("pay_stub.ytd_gross");
    expect(ytd).toMatchObject({ value: null, state: "proposed", match: { method: "not_extracted" } });
    expect(ytd?.source.kind === "box" && ytd.source.ref).toMatchObject({ page: null, bbox: null, words: [] });
  });
});

describe("without a key and with extraction switched off", () => {
  it("fails a document with llm.missing_key when no response was recorded for it", async () => {
    const outcome = await extractDocument(system, world.docs.scope_letter?.id ?? "", {
      mode: "fixture",
      fixturePath: "/nonexistent/fixture.json",
    });
    expect(outcome).toMatchObject({ extraction_status: "failed", error_code: "llm.missing_key" });
  });

  it("opens the task with every slot manual and no proposals", async () => {
    const task = await openReviewTask(system, APP, { manual: true });
    expect(task?.status).toBe("ready");
    expect(store.listDocuments(APP).map((d) => d.extraction_status)).toEqual(["manual", "manual", "manual"]);
    expect(store.listProposals(APP)).toEqual([]);
    const view = taskView(task?.id ?? "");
    expect(view.documents.every((d) => d.flag?.kind === "manual_reading" && d.rows.length === 0)).toBe(true);
    expect(view.can_complete).toBe(true);
  });

  it("follows EXTRACTION_ENABLED when it starts the review after submit", async () => {
    vi.stubEnv("EXTRACTION_ENABLED", "false");
    await startDocumentReview(system, ids(), { call: goodCaller(), ...fast });
    expect(store.listDocuments(APP).map((d) => d.extraction_status)).toEqual(["manual", "manual", "manual"]);
    expect(store.listProposals(APP)).toEqual([]);
    expect(store.listReviewTasks(APP)).toHaveLength(1);

    freshWorld();
    vi.stubEnv("EXTRACTION_ENABLED", "true");
    await startDocumentReview(system, ids(), { call: goodCaller(), ...fast });
    expect(store.listDocuments(APP).map((d) => d.extraction_status)).toEqual(["done", "done", "done"]);
    expect(store.listProposals(APP)).toHaveLength(16);
  });

  it("opens no task for an application without documents", async () => {
    const empty = freshWorld({ slots: [] });
    expect(empty.docs).toEqual({});
    expect(await openReviewTask(system, APP, { manual: true })).toBeNull();
    expect(store.listReviewTasks(APP)).toEqual([]);
  });

  it("does not extract a document twice", async () => {
    const id = world.docs.scope_letter?.id ?? "";
    const calls = { count: 0 };
    await extractDocument(system, id, { call: scriptedCaller([answerFor("scope_letter")], calls), ...fast });
    const again = await extractDocument(system, id, { call: scriptedCaller([answerFor("scope_letter")], calls), ...fast });
    expect(calls.count).toBe(1);
    expect(again.extraction_status).toBe("done");
    expect(eventsOf("extraction.completed")).toHaveLength(1);
  });
});

describe("work that overlaps or is retried", () => {
  const queueMethods = () =>
    (eventsOf("tool.call") as Array<{ service: string; method: string }>)
      .filter((c) => c.service === "review_queue")
      .map((c) => c.method);

  it("reads a document once when two calls overlap, and both get the same outcome", async () => {
    const id = world.docs.scope_letter?.id ?? "";
    const calls = { count: 0 };
    const call = scriptedCaller([answerFor("scope_letter")], calls);
    const [first, second] = await Promise.all([
      extractDocument(system, id, { call, ...fast }),
      extractDocument(system, id, { call, ...fast }),
    ]);
    expect(first.extraction_status).toBe("done");
    expect(second).toEqual(first);
    expect(calls.count).toBe(1);
    expect(eventsOf("extraction.completed")).toHaveLength(1);
    expect(eventsOf("field.proposed")).toHaveLength(4);
    expect(store.listProposals(APP)).toHaveLength(4);
  });

  it("replays the recorded response once for a fixture document that two calls ask for at the same time", async () => {
    const id = world.docs.pay_stub?.id ?? "";
    const [first, second] = await Promise.all([
      extractDocument(system, id, { mode: "fixture" }),
      extractDocument(system, id, { mode: "fixture" }),
    ]);
    expect(second).toEqual(first);
    expect(first.extraction_status).toBe("done");
    const model = eventsOf("model.call");
    expect(model).toHaveLength(1);
    expect(model[0]).toMatchObject({ _fixture: true });
    expect(eventsOf("extraction.completed")).toHaveLength(1);
    expect(store.listProposals(APP).filter((p) => p.state === "proposed")).toHaveLength(7);
    // A call after the run finished is the ordinary "already read" answer, and nothing is shared.
    const later = await extractDocument(system, id, { mode: "fixture" });
    expect(later.fields).toEqual([]);
    expect(eventsOf("model.call")).toHaveLength(1);
  });

  it("runs a second queue over the same documents without a second model call, task or issue", async () => {
    const calls = { count: 0 };
    const answers = goodCaller();
    const counted: ModelCaller = (ctx, request) => {
      calls.count += 1;
      return answers(ctx, request);
    };
    const deps = { call: counted, ...fast };
    await Promise.all([enqueueExtraction(system, ids(), deps), enqueueExtraction(system, ids(), deps)]);
    expect(calls.count).toBe(3);
    expect(store.listDocuments(APP).map((d) => d.extraction_status)).toEqual(["done", "done", "done"]);
    expect(store.listProposals(APP)).toHaveLength(16);
    expect(eventsOf("extraction.completed")).toHaveLength(3);
    expect(store.listReviewTasks(APP)).toHaveLength(1);
    expect(eventsOf("review.task_created")).toHaveLength(1);
    expect(queueMethods()).toEqual(["createIssue", "addLink"]);
  });

  it("opens the task once when two openings overlap", async () => {
    for (const id of ids()) await extractDocument(system, id, { call: goodCaller(), ...fast });
    const [first, second] = await Promise.all([
      openReviewTask(system, APP, { manual: false }),
      openReviewTask(system, APP, { manual: false }),
    ]);
    expect(second?.id).toBe(first?.id);
    expect(store.listReviewTasks(APP)).toHaveLength(1);
    expect(queueMethods()).toEqual(["createIssue", "addLink"]);
  });

  it("reuses the task and its queue issue when the opening is retried", async () => {
    await enqueueExtraction(system, ids(), { call: goodCaller(), ...fast });
    const [task] = store.listReviewTasks(APP);
    expect(queueMethods()).toEqual(["createIssue", "addLink"]);

    const again = await openReviewTask(system, APP, { manual: false });
    await enqueueExtraction(system, ids(), { call: goodCaller(), ...fast });
    await startDocumentReview(system, ids(), { call: goodCaller(), ...fast });

    expect(again).toEqual(task);
    expect(store.listReviewTasks(APP)).toEqual([task]);
    expect(eventsOf("review.task_created")).toHaveLength(1);
    // No second call reached the queue, so no second issue exists.
    expect(queueMethods()).toEqual(["createIssue", "addLink"]);
  });

  it("adds the link a failed first attempt never made, to the issue it already had", async () => {
    const addLink = vi.spyOn(services.reviewQueue, "addLink").mockRejectedValueOnce(new Error("The queue is down."));
    try {
      await expect(enqueueExtraction(system, ids(), { call: goodCaller(), ...fast })).rejects.toThrow("The queue is down.");
      const [task] = store.listReviewTasks(APP);
      expect(task?.jsm_issue_id).toMatch(/^REV-\d+$/);
      expect(queueMethods()).toEqual(["createIssue", "addLink"]);

      // The retry finds the task, keeps its issue, and links it.
      const reopened = await openReviewTask(system, APP, { manual: false });
      expect(reopened?.id).toBe(task?.id);
      expect(queueMethods()).toEqual(["createIssue", "addLink", "addLink"]);
      expect(addLink).toHaveBeenLastCalledWith(task?.jsm_issue_id, { task_id: task?.id, url: `/review/${task?.id}` });
      expect(store.listReviewTasks(APP)).toHaveLength(1);

      // Linked now: a further retry does nothing.
      await openReviewTask(system, APP, { manual: false });
      expect(queueMethods()).toEqual(["createIssue", "addLink", "addLink"]);
    } finally {
      addLink.mockRestore();
    }
  });

  it("gives the task the issue an earlier attempt created before it could open the task", async () => {
    // Not submitted yet: the queue is asked for an issue, then the task is refused.
    freshWorld({ submit: false });
    await expect(openReviewTask(system, APP, { manual: true })).rejects.toThrow(/submitted/);
    expect(queueMethods()).toEqual(["createIssue"]);
    expect(store.listReviewTasks(APP)).toEqual([]);
    const issue = (eventsOf("tool.call") as Array<{ method: string; output: { jsm_issue_id?: string } }>).find(
      (c) => c.method === "createIssue",
    )?.output.jsm_issue_id;

    submitApplication(contractor);
    const task = await openReviewTask(system, APP, { manual: true });
    expect(task?.jsm_issue_id).toBe(issue);
    expect(queueMethods()).toEqual(["createIssue", "addLink"]);
  });

  it("does not ask the queue for an issue while a document is still being read", async () => {
    await expect(openReviewTask(system, APP, { manual: false })).rejects.toThrow(/every document has been read/);
    expect(queueMethods()).toEqual([]);
    expect(store.listReviewTasks(APP)).toEqual([]);
  });
});

describe("a document whose text layer has no words", () => {
  let pictureId = "";
  beforeEach(() => {
    // The pay stub sample is a picture; attached with the text adapter it has to be read by OCR.
    freshWorld({ slots: ["estimate", "scope_letter"], submit: false });
    pictureId = attachDocument(contractor, "pay_stub", "samples/paystub.pdf", "pdfjs").document.id;
    submitApplication(contractor);
  });

  /** An OCR reader that answers with the committed OCR output of the pay stub. */
  const recordedOcr = () => vi.fn(async (_file: Uint8Array, _options?: { signal?: AbortSignal }) => readOcrFixture(ocrPathFor("samples/paystub.pdf")));
  const emptyPage: PositionedText = { pages: [{ page: 1, width: 1, height: 1, words: [] }] };

  it("is read by OCR, and the document and the completion event record the adapter that read it", async () => {
    const ocr = recordedOcr();
    const call = vi.fn(goodCaller());
    const outcome = await extractDocument(system, pictureId, { call, ocr, ...fast });

    expect(ocr).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(ocr.mock.calls[0]?.[0].subarray(0, 5))).toBe("%PDF-");
    expect(ocr.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(call).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ extraction_status: "done", error_code: null });
    expect(store.getDocument(pictureId)).toMatchObject({ adapter: "ocr_tesseract", extraction_status: "done" });

    const done = eventsOf("extraction.completed")[0] as { adapter: string; per_field: Array<{ adapter: string }> };
    expect(done.adapter).toBe("ocr_tesseract");
    expect(done.per_field).toHaveLength(7);
    expect(done.per_field.every((f) => f.adapter === "ocr_tesseract")).toBe(true);
    expect(proposalFor("pay_stub.gross_pay")).toMatchObject({ value: 235000, match: { method: "exact" } });
  });

  it("ends failed with extraction.no_text_layer, without calling the model, when OCR finds no words either", async () => {
    const ocr = vi.fn(async () => emptyPage);
    const call = vi.fn(goodCaller());
    const outcome = await extractDocument(system, pictureId, { call, ocr, ...fast });

    expect(call).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ extraction_status: "failed", error_code: "extraction.no_text_layer" });
    expect(store.getDocument(pictureId)).toMatchObject({ adapter: "ocr_tesseract", extraction_status: "failed" });
    expect(eventsOf("extraction.completed")[0]).toMatchObject({
      adapter: "ocr_tesseract",
      error_code: "extraction.no_text_layer",
      per_field: [],
    });
    expect(store.listProposals(APP)).toEqual([]);
  });

  it("ends failed with extraction.ocr_timeout when OCR runs past its limit, and tells the reader to stop", async () => {
    let signal: AbortSignal | undefined;
    const ocr = vi.fn((_file: Uint8Array, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<PositionedText>(() => undefined); // never answers
    });
    const call = vi.fn(goodCaller());
    const started = Date.now();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let outcome;
    try {
      outcome = await extractDocument(system, pictureId, { call, ocr, ocr_timeout_ms: 40, ...fast });
    } finally {
      errors.mockRestore();
    }

    expect(Date.now() - started).toBeLessThan(5000);
    expect(signal?.aborted).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ extraction_status: "failed", error_code: "extraction.ocr_timeout" });
    expect(store.getDocument(pictureId)).toMatchObject({ adapter: "ocr_tesseract", extraction_status: "failed" });
    expect(eventsOf("extraction.completed")[0]).toMatchObject({ error_code: "extraction.ocr_timeout", per_field: [] });
  });

  it("gives the reader the whole limit: a slow read that finishes in time is used", async () => {
    const ocr = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return readOcrFixture(ocrPathFor("samples/paystub.pdf"));
    });
    const outcome = await extractDocument(system, pictureId, { call: goodCaller(), ocr, ocr_timeout_ms: 2000, ...fast });
    expect(outcome.extraction_status).toBe("done");
  });

  it("ends failed with internal when the OCR engine breaks", async () => {
    const ocr = vi.fn(async (): Promise<PositionedText> => {
      throw new Error("The OCR language data download failed with status 503.");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const outcome = await extractDocument(system, pictureId, { call: goodCaller(), ocr, ...fast });
      expect(outcome).toMatchObject({ extraction_status: "failed", error_code: "internal" });
      expect(store.getDocument(pictureId)).toMatchObject({ adapter: "ocr_tesseract" });
    } finally {
      errors.mockRestore();
    }
  });

  it("never OCRs a document that has a text layer", async () => {
    const ocr = vi.fn(async (): Promise<PositionedText> => {
      throw new Error("OCR must not run.");
    });
    const estimate = store.listDocuments(APP).find((d) => d.slot === "estimate");
    const outcome = await extractDocument(system, estimate?.id ?? "", { call: goodCaller(), ocr, ...fast });
    expect(ocr).not.toHaveBeenCalled();
    expect(outcome.extraction_status).toBe("done");
    expect(store.getDocument(estimate?.id ?? "")?.adapter).toBe("pdfjs");
    expect(eventsOf("extraction.completed")[0]).toMatchObject({ adapter: "pdfjs" });
  });

  it("never OCRs the sample pay stub, which keeps its recorded OCR output", async () => {
    const ocr = vi.fn(async (): Promise<PositionedText> => {
      throw new Error("OCR must not run.");
    });
    world = freshWorld();
    const outcome = await extractDocument(system, world.docs.pay_stub?.id ?? "", { call: goodCaller(), ocr, ...fast });
    expect(ocr).not.toHaveBeenCalled();
    expect(outcome.extraction_status).toBe("done");
    expect(store.getDocument(world.docs.pay_stub?.id ?? "")?.adapter).toBe("ocr_fixture");
    expect(eventsOf("extraction.completed")[0]).toMatchObject({ adapter: "ocr_fixture" });
  });
});
