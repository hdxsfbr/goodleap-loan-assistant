import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FlagReasonSchema } from "@shared/reason-codes";
import { audit } from "../server/audit-log.js";
import { replyToDiscrepancy } from "../server/commands.js";
import { deriveBanner } from "../server/domain/banner.js";
import { errorHandler } from "../server/api/index.js";
import { createReviewRouter } from "../server/api/review.js";
import { enqueueExtraction } from "../server/extraction/extract.js";
import type { TaskView } from "../server/review/tasks.js";
import { SYSTEM_ONLY_FLAG_REASONS } from "../server/review/templates.js";
import { store } from "../server/store.js";
import { APP, contractor, freshWorld, goodCaller, system } from "./helpers/world.js";

// The reviewer routes, mounted in a test-local app (the main router mounts them later).

let base = "";
let close: () => void = () => undefined;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createReviewRouter());
  app.use(errorHandler);
  const listener = app.listen(0);
  await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  close = () => listener.close();
});

afterAll(() => close());

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-session-id": "review-test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, json: type.includes("json") ? ((await res.json()) as any) : null, res };
}

let taskId = "";

async function openTask(options: Parameters<typeof freshWorld>[0] = {}) {
  freshWorld(options);
  await enqueueExtraction(system, store.getApplication(APP)?.document_ids ?? [], { call: goodCaller(), retry_delay_ms: 0 });
  taskId = store.listReviewTasks(APP)[0]?.id ?? "";
}

beforeEach(async () => {
  await openTask();
});

function view(json: unknown): TaskView {
  return json as TaskView;
}

function proposalId(v: TaskView, key: string): string {
  for (const doc of v.documents) {
    const row = doc.rows.find((r) => r.field_key === key);
    if (row?.proposal) return row.proposal.id;
  }
  throw new Error(`no proposal for ${key}`);
}

const decide = (key: string, v: TaskView, body: Record<string, unknown>) =>
  send("POST", `/api/review/tasks/${taskId}/decisions`, { proposal_id: proposalId(v, key), ...body });

describe("reading", () => {
  it("lists the task with its counts", async () => {
    const { status, json } = await send("GET", "/api/review/tasks");
    expect(status).toBe(200);
    expect(json.open_count).toBe(1);
    expect(json.tasks).toEqual([
      expect.objectContaining({ id: taskId, application_id: APP, status: "ready", document_count: 3, undecided_count: 16, open_discrepancies: 0 }),
    ]);
  });

  it("returns the task view: documents, rows by schema field, fixed texts, all JSON-clean", async () => {
    const { status, json } = await send("GET", `/api/review/tasks/${taskId}`);
    expect(status).toBe(200);
    const v = view(json);
    expect(JSON.parse(JSON.stringify(v))).toStrictEqual(v);
    expect(v.documents.map((d) => d.slot)).toEqual(["pay_stub", "estimate", "scope_letter"]);
    expect(v.documents[0]?.rows.map((r) => r.field_id)).toEqual([
      "employer_name", "pay_period_start", "pay_period_end", "pay_frequency", "gross_pay", "net_pay", "ytd_gross", "annualized_income",
    ]);
    expect(v.documents[0]?.file_url).toMatch(/^\/api\/documents\/doc_\d+\/file$/);
    expect(v.can_complete).toBe(false);
    expect(v.undecided_count).toBe(16);
    expect(v.texts.not_located_caption).toBe(
      "The value was extracted but its position on the page could not be matched. Find it on the page to confirm, correct it, or flag it.",
    );
    expect(v.texts.located_acknowledgement).toBe("I located this on the page myself");
    expect(v.texts.flag_reasons.missing).toBe("Missing");
    const gross = v.documents[0]?.rows.find((r) => r.field_id === "gross_pay");
    expect(gross).toMatchObject({ status: "undecided", location: "located", actions: ["confirm", "correct", "flag"], requires_acknowledgement: false });
    expect(v.documents[0]?.rows.find((r) => r.field_id === "net_pay")).toMatchObject({ location: "not_located", requires_acknowledgement: true });
    expect(v.documents[0]?.rows.find((r) => r.field_id === "annualized_income")).toMatchObject({
      status: "waiting",
      proposal: null,
      actions: [],
      compare_to: { field_id: "stated_annual_income", stated_value: 8_500_000 },
    });
  });

  it("lists only the flag reasons a reviewer may choose, never the ones the system writes", async () => {
    const v = view((await send("GET", `/api/review/tasks/${taskId}`)).json);
    expect(Object.keys(v.texts.flag_reasons)).toEqual([
      "illegible",
      "source_not_located",
      "mismatch_with_stated",
      "wrong_document_type",
      "missing",
      "other",
    ]);
    expect(v.texts.flag_reasons).not.toHaveProperty("pay_frequency_not_located");
    expect(Object.values(v.texts.flag_reasons).every((label) => label.trim() !== "")).toBe(true);
    // Every flag reason is either offered to the reviewer or written by the system alone.
    const offered = new Set<string>(Object.keys(v.texts.flag_reasons));
    for (const reason of FlagReasonSchema.options) {
      expect(offered.has(reason) !== (SYSTEM_ONLY_FLAG_REASONS as readonly string[]).includes(reason)).toBe(true);
    }
  });

  it("answers 404 for a task that does not exist, in the error body shape", async () => {
    const { status, json } = await send("GET", "/api/review/tasks/task_99");
    expect(status).toBe(404);
    expect(json).toMatchObject({ code: "internal", retryable: false });
  });

  it("serves the PDF of a document", async () => {
    const doc = store.listDocuments(APP)[1];
    const { status, type, res } = await send("GET", `/api/documents/${doc?.id}/file`);
    expect(status).toBe(200);
    expect(type).toContain("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await send("GET", "/api/documents/doc_99/file")).status).toBe(404);
  });
});

describe("decisions", () => {
  async function current() {
    return view((await send("GET", `/api/review/tasks/${taskId}`)).json);
  }

  it("starts the review on the first decision and records who decided, when and how fast", async () => {
    const v = await current();
    const { status, json } = await decide("pay_stub.gross_pay", v, { action: "confirm" });
    expect(status).toBe(200);
    expect(view(json).task.status).toBe("in_review");
    const events = audit
      .list(APP)
      .filter((e) => e.type === "review.started" || (e.type === "field.confirmed" && e.review_task_id !== undefined));
    expect(events.map((e) => e.type)).toEqual(["review.started", "field.confirmed"]);
    expect(events[1]).toMatchObject({ review_task_id: taskId, actor: { type: "reviewer", id: "rev_demo_001" }, session_id: "review-test" });
    expect(typeof (events[1] as { elapsed_ms?: number }).elapsed_ms).toBe("number");
    const row = view(json).documents[0]?.rows.find((r) => r.field_id === "gross_pay");
    // Gross pay feeds the income, so it stays correctable while the review is open.
    expect(row).toMatchObject({ status: "confirmed", actions: ["correct"] });
    expect(row?.decision).toMatchObject({ action: "confirm", value: 235000, actor: { type: "reviewer" } });
    expect(view(json).undecided_count).toBe(15);
    // A second decision on the same value is refused.
    expect((await decide("pay_stub.gross_pay", v, { action: "confirm" })).status).toBe(409);
  });

  it("refuses to confirm a not-located value without the acknowledgement, then accepts it with", async () => {
    const v = await current();
    const refused = await decide("pay_stub.net_pay", v, { action: "confirm" });
    expect(refused.status).toBe(409);
    expect(refused.json.message).toContain("I located this on the page myself");
    // A refused decision leaves the task as it was.
    expect(store.getReviewTask(taskId)?.status).toBe("ready");
    expect(audit.list(APP).some((e) => e.type === "review.started")).toBe(false);

    const accepted = await decide("pay_stub.net_pay", v, { action: "confirm", located_by_reviewer: true });
    expect(accepted.status).toBe(200);
    const net = store.getProposal(proposalId(v, "pay_stub.net_pay"));
    expect(net).toMatchObject({ state: "confirmed", located_by_reviewer: true });
    expect(view(accepted.json).documents[0]?.rows.find((r) => r.field_id === "net_pay")?.decision).toMatchObject({
      located_by_reviewer: true,
    });
  });

  it("corrects with a typed value and keeps the box as the place it was read from", async () => {
    const v = await current();
    const bad = await decide("pay_stub.gross_pay", v, { action: "correct", value: "lots" });
    expect(bad.status).toBe(400);
    const missing = await decide("pay_stub.gross_pay", v, { action: "correct" });
    expect(missing.status).toBe(400);

    const ok = await decide("pay_stub.gross_pay", v, { action: "correct", value: "$2,400.00" });
    expect(ok.status).toBe(200);
    const row = view(ok.json).documents[0]?.rows.find((r) => r.field_id === "gross_pay");
    expect(row).toMatchObject({ status: "edited", location: "located" });
    expect(row?.proposal?.value).toBe(240000);
    expect(row?.proposal?.source.kind === "box" && row.proposal.source.ref.bbox).not.toBeNull();
    expect(row?.decision).toMatchObject({ action: "correct", before: 235000, value: 240000 });
  });

  it("accepts a later correction of gross pay or pay frequency and calculates the income again, but no other second decision", async () => {
    const v = await current();
    expect((await decide("pay_stub.gross_pay", v, { action: "confirm" })).status).toBe(200);
    const confirmed = await decide("pay_stub.pay_frequency", v, { action: "confirm" });
    const income = (r: { json: unknown }) =>
      view(r.json).documents[0]?.rows.find((row) => row.field_id === "annualized_income");
    expect(income(confirmed)).toMatchObject({ status: "confirmed", proposal: { value: 6_110_000 } });

    // The id of the decided value is still the one the screen holds; a correction replaces it.
    expect((await decide("pay_stub.gross_pay", v, { action: "confirm" })).status).toBe(409);
    expect((await decide("pay_stub.gross_pay", v, { action: "flag", reason_code: "illegible" })).status).toBe(409);
    expect((await decide("pay_stub.employer_name", v, { action: "confirm" })).status).toBe(200);
    expect((await decide("pay_stub.employer_name", v, { action: "correct", value: "Someone Else" })).status).toBe(409);

    const corrected = await decide("pay_stub.gross_pay", v, { action: "correct", value: "$2,400.00" });
    expect(corrected.status).toBe(200);
    expect(income(corrected)).toMatchObject({ status: "confirmed", proposal: { value: 6_240_000 } });
    const gross = view(corrected.json).documents[0]?.rows.find((r) => r.field_id === "gross_pay");
    expect(gross).toMatchObject({ status: "edited", decision: { action: "correct", before: 235_000, value: 240_000 } });
    expect(store.getApplication(APP)?.verified.verified_annual_income).toBe(6_240_000);
    expect(view(corrected.json).undecided_count).toBe(13);

    // The id the screen held before the correction is stale now.
    expect((await decide("pay_stub.gross_pay", v, { action: "correct", value: "$2,500.00" })).status).toBe(409);
    // A correction the server cannot read changes nothing.
    const fresh = await current();
    expect((await decide("pay_stub.gross_pay", fresh, { action: "correct", value: "lots" })).status).toBe(400);
    expect(store.getApplication(APP)?.verified.verified_annual_income).toBe(6_240_000);
  });

  it("offers Correct on a decided gross pay or pay frequency, newest proposal only, and on nothing else once decided", async () => {
    const v = await current();
    const rowsOf = (r: { json: unknown }) => view(r.json).documents[0]?.rows ?? [];
    const actionsOf = (rows: ReturnType<typeof rowsOf>, id: string) => rows.find((row) => row.field_id === id)?.actions;

    expect((await decide("pay_stub.employer_name", v, { action: "confirm" })).status).toBe(200);
    const confirmed = await decide("pay_stub.gross_pay", v, { action: "confirm" });
    // The two inputs of the income can be corrected after they are decided; other decided rows cannot.
    expect(actionsOf(rowsOf(confirmed), "gross_pay")).toEqual(["correct"]);
    expect(actionsOf(rowsOf(confirmed), "employer_name")).toEqual([]);
    expect(actionsOf(rowsOf(confirmed), "pay_frequency")).toEqual(["confirm", "correct", "flag"]);

    const both = await decide("pay_stub.pay_frequency", v, { action: "confirm" });
    expect(actionsOf(rowsOf(both), "pay_frequency")).toEqual(["correct"]);
    expect(actionsOf(rowsOf(both), "annualized_income")).toEqual(["flag"]);

    // A corrected input can be corrected again: the row holds the newest proposal, which is now edited.
    const corrected = await decide("pay_stub.gross_pay", v, { action: "correct", value: "$2,400.00" });
    const gross = rowsOf(corrected).find((row) => row.field_id === "gross_pay");
    expect(gross).toMatchObject({ status: "edited", actions: ["correct"] });
    const again = await send("POST", `/api/review/tasks/${taskId}/decisions`, {
      proposal_id: gross?.proposal?.id,
      action: "correct",
      value: "$2,500.00",
    });
    expect(again.status).toBe(200);
    expect(actionsOf(rowsOf(again), "gross_pay")).toEqual(["correct"]);
    expect(store.getApplication(APP)?.verified.verified_annual_income).toBe(6_500_000);
  });

  it("offers nothing on a flagged input: it is decided, but no value stands behind the income", async () => {
    const v = await current();
    const flagged = await decide("pay_stub.pay_frequency", v, { action: "flag", reason_code: "illegible" });
    const rows = view(flagged.json).documents[0]?.rows ?? [];
    expect(rows.find((row) => row.field_id === "pay_frequency")).toMatchObject({ status: "flagged", actions: [] });
  });

  it("flags with a fixed reason, and a value that was never found is flagged as missing by default", async () => {
    const v = await current();
    expect((await decide("pay_stub.gross_pay", v, { action: "flag" })).status).toBe(400);
    expect((await decide("pay_stub.gross_pay", v, { action: "flag", reason_code: "nonsense" })).status).toBe(400);
    const flagged = await decide("pay_stub.gross_pay", v, { action: "flag", reason_code: "illegible", note: "Smudged" });
    expect(flagged.status).toBe(200);
    expect(view(flagged.json).documents[0]?.rows.find((r) => r.field_id === "gross_pay")).toMatchObject({
      status: "flagged",
      decision: { action: "flag", reason_code: "illegible", note: "Smudged" },
    });
  });

  it("offers Correct and Flag on a row the model left empty, and flags it as missing", async () => {
    freshWorld();
    await enqueueExtraction(system, store.getApplication(APP)?.document_ids ?? [], {
      call: goodCaller({
        estimate: JSON.stringify({
          document_matches_slot: true,
          fields: {
            contractor_name: null,
            project_description: null,
            estimate_date: null,
            total_amount: null,
            line_item_count: null,
          },
        }),
      }),
      retry_delay_ms: 0,
    });
    taskId = store.listReviewTasks(APP)[0]?.id ?? "";
    const v = await current();
    const row = v.documents[1]?.rows.find((r) => r.field_id === "total_amount");
    expect(row).toMatchObject({ location: "not_extracted", actions: ["correct", "flag"], proposal: { value: null } });
    expect((await decide("estimate.total_amount", v, { action: "confirm" })).status).toBe(409);
    const flagged = await decide("estimate.total_amount", v, { action: "flag" });
    expect(flagged.status).toBe(200);
    expect(view(flagged.json).documents[1]?.rows.find((r) => r.field_id === "total_amount")?.decision).toMatchObject({
      reason_code: "missing",
    });
  });

  it("rejects a body the schema does not describe and a proposal that is not part of the task", async () => {
    const v = await current();
    expect((await send("POST", `/api/review/tasks/${taskId}/decisions`, { action: "confirm" })).status).toBe(400);
    expect((await decide("pay_stub.gross_pay", v, { action: "confirm", surprise: true })).status).toBe(400);
    expect((await send("POST", `/api/review/tasks/${taskId}/decisions`, { proposal_id: "p_999", action: "confirm" })).status).toBe(404);
    expect((await send("POST", "/api/review/tasks/task_99/decisions", { proposal_id: "p_1", action: "confirm" })).status).toBe(404);
  });
});

describe("completing the review and the question to the contractor", () => {
  async function decideEverything() {
    let v = view((await send("GET", `/api/review/tasks/${taskId}`)).json);
    for (const doc of v.documents) {
      for (const row of doc.rows) {
        if (row.actions.includes("confirm") && row.proposal) {
          const body = row.requires_acknowledgement ? { action: "confirm", located_by_reviewer: true } : { action: "confirm" };
          const res = await send("POST", `/api/review/tasks/${taskId}/decisions`, { proposal_id: row.proposal.id, ...body });
          expect(res.status).toBe(200);
          v = view(res.json);
        }
      }
    }
    return v;
  }

  it("is refused while a value has no state, then moves the application to documents_reviewed", async () => {
    const early = await send("POST", `/api/review/tasks/${taskId}/complete`);
    expect(early.status).toBe(409);
    expect(early.json.message).toMatch(/16 values still need a decision/);

    const v = await decideEverything();
    expect(v.can_complete).toBe(true);
    expect(v.undecided_count).toBe(0);
    const done = await send("POST", `/api/review/tasks/${taskId}/complete`);
    expect(done.status).toBe(200);
    expect(view(done.json).task.status).toBe("complete");
    expect(store.getApplication(APP)?.status).toBe("documents_reviewed");
    expect((await send("POST", `/api/review/tasks/${taskId}/complete`)).status).toBe(409);
  });

  it("offers no correction on a decided input once the review is complete", async () => {
    const v = await decideEverything();
    expect(v.documents[0]?.rows.find((r) => r.field_id === "gross_pay")?.actions).toEqual(["correct"]);
    const done = view((await send("POST", `/api/review/tasks/${taskId}/complete`)).json);
    expect(done.task.status).toBe("complete");
    expect(done.documents[0]?.rows.find((r) => r.field_id === "gross_pay")?.actions).toEqual([]);
    expect(done.documents[0]?.rows.find((r) => r.field_id === "pay_frequency")?.actions).toEqual([]);
  });

  it("walks CUJ 5: the difference opens, the question is sent, the contractor answers, the reviewer resolves", async () => {
    const v = await decideEverything();
    expect(v.discrepancies).toHaveLength(1);
    const record = v.discrepancies[0]!.record;
    expect(record).toMatchObject({ reason_code: "income_outside_tolerance", status: "open" });
    expect(record.sent_at).toBeUndefined();
    expect(deriveBanner(store.listDiscrepancies(APP))).toBeNull();
    expect(store.getApplication(APP)?.verified.verified_annual_income).toBe(6_110_000);

    const path = `/api/review/tasks/${taskId}/discrepancies/${record.id}`;
    expect((await send("POST", `${path}/send`, { text: "   " })).status).toBe(400);
    expect((await send("POST", `${path}/resolve`, { resolution: "explained", note: "too early" })).status).toBe(409);

    const sent = await send("POST", `${path}/send`, { text: `${record.question.text} (Please reply today.)` });
    expect(sent.status).toBe(200);
    expect(view(sent.json).discrepancies[0]?.record.sent_at).toBeDefined();
    expect(deriveBanner(store.listDiscrepancies(APP))?.text).toMatch(/^Needs clarification/);

    replyToDiscrepancy(contractor, record.id, "She also has a second job; the stated income includes both.");
    const reply = view((await send("GET", `/api/review/tasks/${taskId}`)).json);
    expect(reply.discrepancies[0]?.record.contractor_reply?.text).toContain("second job");

    expect((await send("POST", `${path}/resolve`, { resolution: "explained", note: "" })).status).toBe(400);
    expect((await send("POST", `${path}/resolve`, { resolution: "approved", note: "x" })).status).toBe(400);
    const resolved = await send("POST", `${path}/resolve`, { resolution: "explained", note: "Second job accounts for the difference." });
    expect(resolved.status).toBe(200);
    expect(view(resolved.json).discrepancies[0]?.record).toMatchObject({ status: "resolved", resolution: "explained" });
    expect(deriveBanner(store.listDiscrepancies(APP))).toBeNull();
  });

  it("does not let another task's route reach a record", async () => {
    await decideEverything();
    const record = store.listDiscrepancies(APP)[0];
    expect((await send("POST", `/api/review/tasks/task_99/discrepancies/${record?.id}/send`, { text: "Hello" })).status).toBe(404);
    expect((await send("POST", `/api/review/tasks/${taskId}/discrepancies/disc_99/send`, { text: "Hello" })).status).toBe(404);
  });
});
