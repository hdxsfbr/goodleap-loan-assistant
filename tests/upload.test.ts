import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationView, AuditEvent, DocumentSlot } from "@shared/schemas";
import { audit } from "../server/audit-log.js";
import { attachDocument, replaceDocument, reserveDocumentId, submitApplication } from "../server/commands.js";
import { createApiRouter } from "../server/api/index.js";
import { shutdownOcr } from "../server/extraction/adapters/ocr-tesseract.js";
import { enqueueExtraction } from "../server/extraction/extract.js";
import type { ModelCaller } from "../server/extraction/llm.js";
import type { PositionedText } from "../server/extraction/positioned-text.js";
import type { TaskView } from "../server/review/tasks.js";
import { services } from "../server/services/index.js";
import { createDocumentsMock } from "../server/services/documents/mock.js";
import { store } from "../server/store.js";
import { MAX_UPLOAD_BYTES, sanitizeFileName } from "../server/uploads.js";
import { ocrUnavailableReason } from "./helpers/ocr.js";
import { simplePdf } from "./helpers/pdf.js";
import { APP, answerFor, contractor, freshWorld, goodCaller, system } from "./helpers/world.js";

// The prototype's file picker: PDFs posted to a document slot, kept by the documents service
// (here in a temporary directory) and attached through the same commands as the bundled samples.

const BAD_FILE = "Only PDF files up to 10 MB can be attached.";
const NOT_DRAFT = "Documents can be attached only before the application is submitted.";

const sample = (name: string): Buffer => readFileSync(join(import.meta.dirname, "..", "samples", name));

let base = "";
let uploadsDir = "";
let close: () => void = () => undefined;
const realDocuments = services.documents;

beforeAll(async () => {
  uploadsDir = mkdtempSync(join(tmpdir(), "uploads-test-"));
  services.documents = createDocumentsMock({ uploadsDir });
  const app = express();
  app.use(createApiRouter());
  const listener = app.listen(0);
  await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  close = () => listener.close();
});

afterAll(async () => {
  await shutdownOcr();
  close();
  services.documents = realDocuments;
  rmSync(uploadsDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of readdirSync(uploadsDir)) rmSync(join(uploadsDir, name), { force: true });
  // A draft application with its required fields and no documents.
  freshWorld({ slots: [], submit: false });
});

function upload(slot: string, body: Uint8Array | string | undefined, headers: Record<string, string> = {}, app = APP) {
  return fetch(`${base}/api/applications/${app}/documents/${slot}`, {
    method: "POST",
    headers: { "content-type": "application/pdf", "x-session-id": "upload-test", ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

const get = (path: string) => fetch(`${base}${path}`, { headers: { "x-session-id": "upload-test" } });

async function view(res: Response): Promise<ApplicationView> {
  return (await res.json()) as ApplicationView;
}

function documentOf(v: ApplicationView, slot: DocumentSlot) {
  return v.documents.find((d) => d.slot === slot);
}

const events = <T extends AuditEvent["type"]>(type: T) =>
  audit.list(APP).filter((e): e is Extract<AuditEvent, { type: T }> => e.type === type);

const filesOnDisk = () => readdirSync(uploadsDir).sort();

async function expectRefused(res: Response, status: number, message: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ code: "internal", message, retryable: false });
}

describe("attaching a file", () => {
  it("attaches a PDF to its slot and serves the same bytes back", async () => {
    const bytes = sample("estimate.pdf");
    const res = await upload("estimate", bytes, { "x-file-name": "estimate.pdf" });
    expect(res.status).toBe(200);
    const v = await view(res);
    const doc = documentOf(v, "estimate");
    expect(doc).toMatchObject({
      application_id: APP,
      slot: "estimate",
      file_ref: "uploads/estimate.pdf",
      adapter: "pdfjs",
      extraction_status: "pending",
    });
    expect(v.document_ids).toEqual([doc?.id]);

    const served = await get(`/api/documents/${doc?.id}/file`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("application/pdf");
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
    expect(filesOnDisk()).toEqual([`${doc?.id}.pdf`]);

    const attached = events("document.attached");
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ document_id: doc?.id, slot: "estimate", adapter: "pdfjs" });
    expect(attached[0]).not.toHaveProperty("replaces");
    expect(attached[0]?.actor).toEqual(contractor.actor);
    // The documents service's write is on the audit trail like its reads.
    const put = audit.list(APP).find((e) => e.type === "tool.call" && e.service === "documents" && e.method === "putFile");
    expect(put).toMatchObject({ input: { document_id: doc?.id, file_name: "estimate.pdf", size_bytes: bytes.byteLength } });
  });

  it("keeps the name the browser sent, decoded and cut down to a file name", async () => {
    const res = await upload("scope_letter", sample("scope_letter.pdf"), {
      "x-file-name": encodeURIComponent("C:\\Users\\Maria\\Scope of work (final) é.pdf"),
    });
    expect(documentOf(await view(res), "scope_letter")?.file_ref).toBe("uploads/Scope of work (final) é.pdf");
  });

  it("falls back to <slot>.pdf when no name is sent", async () => {
    const res = await upload("pay_stub", sample("paystub.pdf"));
    expect(documentOf(await view(res), "pay_stub")?.file_ref).toBe("uploads/pay_stub.pdf");
  });

  it("sanitizes names", () => {
    expect(sanitizeFileName(undefined, "estimate")).toBe("estimate.pdf");
    expect(sanitizeFileName("", "estimate")).toBe("estimate.pdf");
    expect(sanitizeFileName("..", "pay_stub")).toBe("pay_stub.pdf");
    expect(sanitizeFileName("a/b/", "pay_stub")).toBe("pay_stub.pdf");
    expect(sanitizeFileName("../../etc/passwd.pdf", "estimate")).toBe("passwd.pdf");
    expect(sanitizeFileName("..\\..\\win.pdf", "estimate")).toBe("win.pdf");
    expect(sanitizeFileName("bad\u0000name\n.pdf", "estimate")).toBe("badname.pdf");
    expect(sanitizeFileName("100%.pdf", "estimate")).toBe("100%.pdf");
    expect(sanitizeFileName(encodeURIComponent("résumé.pdf"), "estimate")).toBe("résumé.pdf");
    const long = sanitizeFileName(`${"x".repeat(300)}.pdf`, "estimate");
    expect(long).toHaveLength(120);
    expect(long.endsWith("x.pdf")).toBe(true);
    expect(sanitizeFileName("y".repeat(300), "estimate")).toHaveLength(120);
  });
});

describe("files the form refuses", () => {
  const nothingChanged = async () => {
    expect(store.listDocuments(APP)).toEqual([]);
    expect(filesOnDisk()).toEqual([]);
    expect(events("document.attached")).toEqual([]);
  };

  it("refuses a body that is not a PDF", async () => {
    await expectRefused(await upload("estimate", "this is plain text"), 400, BAD_FILE);
    await expectRefused(await upload("estimate", "%PDF"), 400, BAD_FILE);
    await nothingChanged();
  });

  it("refuses an empty body and a body declared as anything but a PDF", async () => {
    await expectRefused(await upload("estimate", undefined), 400, BAD_FILE);
    await expectRefused(await upload("estimate", new Uint8Array(0)), 400, BAD_FILE);
    await expectRefused(await upload("estimate", sample("estimate.pdf"), { "content-type": "text/plain" }), 400, BAD_FILE);
    await expectRefused(await upload("estimate", "{}", { "content-type": "application/json" }), 400, BAD_FILE);
    await nothingChanged();
  });

  it("refuses a body over 10 MB", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(MAX_UPLOAD_BYTES)]);
    await expectRefused(await upload("estimate", big), 400, BAD_FILE);
    await nothingChanged();
  });

  it("accepts a PDF of exactly 10 MB", async () => {
    const edge = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(MAX_UPLOAD_BYTES - 5)]);
    expect((await upload("estimate", edge)).status).toBe(200);
    expect(store.listDocuments(APP)).toHaveLength(1);
  });

  it("answers 404 for an unknown application and an unknown slot", async () => {
    await expectRefused(await upload("estimate", sample("estimate.pdf"), {}, "app_nope"), 404, "Application app_nope was not found.");
    await expectRefused(await upload("bank_statement", sample("estimate.pdf")), 404, "That is not a document slot.");
    await nothingChanged();
  });
});

describe("replacing a file before submit", () => {
  it("supersedes the old document, drops its file and says so in the audit", async () => {
    const first = documentOf(await view(await upload("estimate", sample("estimate.pdf"), { "x-file-name": "old.pdf" })), "estimate");
    const second = sample("scope_letter.pdf");
    const res = await upload("estimate", second, { "x-file-name": "new.pdf" });
    expect(res.status).toBe(200);
    const v = await view(res);
    const doc = documentOf(v, "estimate");

    expect(v.documents.filter((d) => d.slot === "estimate")).toHaveLength(1);
    expect(doc?.id).not.toBe(first?.id);
    expect(doc?.file_ref).toBe("uploads/new.pdf");
    expect(v.document_ids).toEqual([doc?.id]);
    expect(store.getDocument(first?.id ?? "")).toBeUndefined();

    // The new file is served; the old document and its file are gone.
    const served = await get(`/api/documents/${doc?.id}/file`);
    expect(Buffer.from(await served.arrayBuffer()).equals(second)).toBe(true);
    expect((await get(`/api/documents/${first?.id}/file`)).status).toBe(404);
    expect(filesOnDisk()).toEqual([`${doc?.id}.pdf`]);

    const attached = events("document.attached");
    expect(attached).toHaveLength(2);
    expect(attached[0]).not.toHaveProperty("replaces");
    expect(attached[1]).toMatchObject({ document_id: doc?.id, slot: "estimate", replaces: first?.id });
  });

  it("leaves the other slots and the order of the documents alone", async () => {
    await upload("pay_stub", sample("paystub.pdf"));
    await upload("estimate", sample("estimate.pdf"));
    await upload("scope_letter", sample("scope_letter.pdf"));
    const before = store.getApplication(APP)?.document_ids ?? [];
    const v = await view(await upload("estimate", sample("estimate.pdf")));
    expect(v.documents.map((d) => d.slot).sort()).toEqual(["estimate", "pay_stub", "scope_letter"]);
    expect(v.document_ids).toHaveLength(3);
    expect(v.document_ids[0]).toBe(before[0]);
    expect(v.document_ids[2]).toBe(before[2]);
    expect(v.document_ids[1]).not.toBe(before[1]);
    // The listing the review task is built from keeps the slot order too.
    expect(store.listDocuments(APP).map((d) => d.slot)).toEqual(["pay_stub", "estimate", "scope_letter"]);
  });

  it("replaces a bundled sample from Load demo project, which is read by the text layer from then on", async () => {
    const demo = await view(await fetch(`${base}/api/applications/${APP}/load-demo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    const stub = documentOf(demo, "pay_stub");
    expect(stub).toMatchObject({ file_ref: "samples/paystub.pdf", adapter: "ocr_fixture" });
    // The sample is still served for the demo.
    expect((await get(`/api/documents/${stub?.id}/file`)).status).toBe(200);

    const v = await view(await upload("pay_stub", sample("paystub.pdf"), { "x-file-name": "my-pay-stub.pdf" }));
    expect(documentOf(v, "pay_stub")).toMatchObject({ file_ref: "uploads/my-pay-stub.pdf", adapter: "pdfjs" });
    expect(documentOf(v, "estimate")).toMatchObject({ file_ref: "samples/estimate.pdf", adapter: "pdfjs" });
    expect(events("document.attached").at(-1)).toMatchObject({ slot: "pay_stub", replaces: stub?.id });
    // Load demo again keeps the contractor's file.
    const again = await view(await fetch(`${base}/api/applications/${APP}/load-demo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(documentOf(again, "pay_stub")?.file_ref).toBe("uploads/my-pay-stub.pdf");
  });
});

describe("after submit", () => {
  it("refuses a new file and a replacement with 409 and changes nothing", async () => {
    await upload("estimate", sample("estimate.pdf"));
    submitApplication(contractor);
    const before = filesOnDisk();
    const attachedBefore = events("document.attached").length;

    await expectRefused(await upload("scope_letter", sample("scope_letter.pdf")), 409, NOT_DRAFT);
    await expectRefused(await upload("estimate", sample("scope_letter.pdf")), 409, NOT_DRAFT);
    // Checked before the body is read, so even a file that is not a PDF gets the 409.
    await expectRefused(await upload("estimate", "text"), 409, NOT_DRAFT);

    expect(filesOnDisk()).toEqual(before);
    expect(events("document.attached")).toHaveLength(attachedBefore);
    expect(store.listDocuments(APP).map((d) => d.slot)).toEqual(["estimate"]);
  });
});

describe("the commands", () => {
  it("replaceDocument needs a document in the slot and a draft", () => {
    expect(() => replaceDocument(contractor, "estimate", "samples/estimate.pdf", "pdfjs")).toThrow(
      "There is no document in that slot to replace.",
    );
    attachDocument(contractor, "estimate", "samples/estimate.pdf", "pdfjs");
    submitApplication(contractor);
    expect(() => replaceDocument(contractor, "estimate", "samples/estimate.pdf", "pdfjs")).toThrow(
      "Documents can't be attached after the application has been submitted.",
    );
    expect(events("document.attached")).toHaveLength(1);
  });

  it("attachDocument still allows one document per slot", () => {
    attachDocument(contractor, "estimate", "samples/estimate.pdf", "pdfjs");
    expect(() => attachDocument(contractor, "estimate", "samples/estimate.pdf", "pdfjs")).toThrow(
      "A document is already attached to that slot.",
    );
  });

  it("takes a reserved id once, and only a document id", () => {
    const id = reserveDocumentId();
    const { document } = attachDocument(contractor, "estimate", "uploads/e.pdf", "pdfjs", { document_id: id });
    expect(document.id).toBe(id);
    expect(() => attachDocument(contractor, "pay_stub", "uploads/p.pdf", "pdfjs", { document_id: id })).toThrow(
      "That is not a free document id.",
    );
    expect(() => attachDocument(contractor, "pay_stub", "uploads/p.pdf", "pdfjs", { document_id: "../etc" })).toThrow(
      "That is not a free document id.",
    );
    expect(store.listDocuments(APP)).toHaveLength(1);
  });
});

describe("a PDF with no text layer", () => {
  /** A scripted model that records which documents it was asked about. */
  function countingCaller() {
    const inner = goodCaller();
    const asked: string[] = [];
    const call: ModelCaller = async (ctx, request) => {
      asked.push(request.user.split("\n")[0] ?? "");
      return inner(ctx, request);
    };
    return { call, asked };
  }

  /** An OCR reader that finds no words on the page. */
  const nothingToRead = () =>
    vi.fn(async (): Promise<PositionedText> => ({ pages: [{ page: 1, width: 1, height: 1, words: [] }] }));
  const blankPdf = simplePdf([null]);

  it("is marked failed with extraction.no_text_layer when OCR finds no words either, never sent to the model, and flagged for manual reading", async () => {
    // A page with no marks: no text layer, and nothing for OCR to read.
    const stubId = documentOf(await view(await upload("pay_stub", blankPdf)), "pay_stub")?.id ?? "";
    const estimateId = documentOf(await view(await upload("estimate", sample("estimate.pdf"))), "estimate")?.id ?? "";
    expect(store.getDocument(stubId)?.adapter).toBe("pdfjs");

    const ids = submitApplication(contractor);
    const { call, asked } = countingCaller();
    const ocr = nothingToRead();
    await enqueueExtraction(system, ids, { call, ocr, retry_delay_ms: 0 });

    expect(ocr).toHaveBeenCalledTimes(1); // the estimate has a text layer and is not OCR'd
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Project estimate");
    expect(store.getDocument(stubId)?.extraction_status).toBe("failed");
    expect(store.getDocument(estimateId)).toMatchObject({ extraction_status: "done", adapter: "pdfjs" });
    expect(store.listProposals(APP).filter((p) => p.field_key.startsWith("pay_stub."))).toEqual([]);

    const completed = events("extraction.completed").find((e) => e.document_id === stubId);
    expect(completed).toMatchObject({
      extraction_status: "failed",
      adapter: "ocr_tesseract",
      error_code: "extraction.no_text_layer",
      per_field: [],
    });

    const task = store.listReviewTasks(APP)[0];
    expect(task?.status).toBe("ready");
    const res = await get(`/api/review/tasks/${task?.id}`);
    const tv = (await res.json()) as TaskView;
    const stub = tv.documents.find((d) => d.slot === "pay_stub");
    expect(stub).toMatchObject({
      extraction_status: "failed",
      adapter: "ocr_tesseract",
      flag: { kind: "manual_reading", reason_code: null },
      rows: [],
    });
    expect(tv.documents.find((d) => d.slot === "estimate")?.rows.length).toBeGreaterThan(0);
    expect(existsSync(join(uploadsDir, `${stubId}.pdf`))).toBe(true);
  });

  it("opens an extraction_failed task when it is the only document", async () => {
    await upload("pay_stub", blankPdf);
    const ids = submitApplication(contractor);
    await enqueueExtraction(system, ids, { call: goodCaller(), ocr: nothingToRead(), retry_delay_ms: 0 });
    expect(store.listReviewTasks(APP)[0]?.status).toBe("extraction_failed");
  });

  it("does not change the committed pay stub, which is still read from its OCR output", async () => {
    await fetch(`${base}/api/applications/${APP}/load-demo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const ids = submitApplication(contractor);
    const ocr = nothingToRead();
    await enqueueExtraction(system, ids, { call: goodCaller(), ocr, retry_delay_ms: 0 });
    const stub = store.listDocuments(APP).find((d) => d.slot === "pay_stub");
    expect(stub).toMatchObject({ adapter: "ocr_fixture", extraction_status: "done" });
    expect(ocr).not.toHaveBeenCalled();
  });
});

/** The row of the model's prompt that holds `value`, as the line and the word span a model would answer with. */
function spanInPrompt(prompt: string, value: string): { value: string; line: number; start: number; end: number } {
  const wanted = value.split(" ");
  for (const row of prompt.split("\n")) {
    const match = /^p1 L(\d+): (.*)$/.exec(row);
    if (!match) continue;
    const words = (match[2] ?? "").split(/ \| | /);
    for (let at = 0; at + wanted.length <= words.length; at += 1) {
      if (words.slice(at, at + wanted.length).join(" ") === value) {
        return { value, line: Number(match[1]), start: at, end: at + wanted.length - 1 };
      }
    }
  }
  throw new Error(`"${value}" is not in the OCR text the model was shown:\n${prompt}`);
}

describe("a picture-only pay stub, read by the OCR engine", () => {
  it("goes through the tesseract adapter and yields located proposals", async (ctx) => {
    const skip = await ocrUnavailableReason();
    if (skip) return ctx.skip();

    const stubId = documentOf(await view(await upload("pay_stub", sample("paystub.pdf"))), "pay_stub")?.id ?? "";
    await upload("estimate", sample("estimate.pdf"));
    await upload("scope_letter", sample("scope_letter.pdf"));
    expect(store.getDocument(stubId)?.adapter).toBe("pdfjs");

    // A scripted model that reads the pay stub's OCR text as the prompt shows it.
    const inner = goodCaller();
    const call: ModelCaller = async (callCtx, request) => {
      if (!request.user.startsWith("Expected document: Pay stub.")) return inner(callCtx, request);
      const fields = {
        employer_name: "Pinecrest Harbor Logistics",
        pay_period_start: "10/05/2026",
        pay_period_end: "10/18/2026",
        pay_frequency: "Biweekly",
        gross_pay: "2,350.00",
        net_pay: "1,812.40",
        ytd_gross: "49,350.00",
      };
      const picked = Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, spanInPrompt(request.user, value)]));
      return { event_id: "evt_scripted", model_id: "scripted-model", text: answerFor("pay_stub", picked), stop_reason: "end_turn" };
    };

    const ids = submitApplication(contractor);
    await enqueueExtraction(system, ids, { call, retry_delay_ms: 0 });

    expect(store.getDocument(stubId)).toMatchObject({ adapter: "ocr_tesseract", extraction_status: "done" });
    const completed = events("extraction.completed").find((e) => e.document_id === stubId);
    expect(completed).toMatchObject({ adapter: "ocr_tesseract", extraction_status: "done" });
    expect(completed?.per_field).toHaveLength(7);
    expect(completed?.per_field.every((f) => f.adapter === "ocr_tesseract" && f.match_method === "exact")).toBe(true);

    // Every value is located with a box inside the page; the net pay figure too, now that OCR has its geometry.
    const proposals = store.listProposals(APP).filter((p) => p.field_key.startsWith("pay_stub."));
    expect(proposals).toHaveLength(7);
    for (const proposal of proposals) {
      expect(proposal.match).toEqual({ method: "exact" });
      const box = proposal.source.kind === "box" ? proposal.source.ref.bbox : null;
      expect(box, proposal.field_key).not.toBeNull();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.w ?? 0)).toBeLessThanOrEqual(1);
      expect((box?.y ?? 0) + (box?.h ?? 0)).toBeLessThanOrEqual(1);
    }
    expect(proposals.find((p) => p.field_key === "pay_stub.gross_pay")?.value).toBe(235000);
    expect(proposals.find((p) => p.field_key === "pay_stub.net_pay")?.value).toBe(181240);

    const task = store.listReviewTasks(APP)[0];
    const tv = (await (await get(`/api/review/tasks/${task?.id}`)).json()) as TaskView;
    const stub = tv.documents.find((d) => d.slot === "pay_stub");
    expect(stub).toMatchObject({ extraction_status: "done", adapter: "ocr_tesseract" });
    // Seven read values, all located, and the derived annualized income.
    expect(stub?.rows).toHaveLength(8);
    expect(stub?.rows.filter((r) => r.location === "located")).toHaveLength(7);
    expect(stub?.rows.find((r) => r.field_id === "annualized_income")?.location).toBe("derived");
    expect(tv.documents.find((d) => d.slot === "estimate")?.adapter).toBe("pdfjs");
  }, 180_000);
});
