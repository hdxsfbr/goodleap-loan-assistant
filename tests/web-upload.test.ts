import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationView, DocumentRecord } from "@shared/schemas";
import { BAD_FILE_MESSAGE, NO_FILE_LABEL, UPLOADING_LABEL } from "../web/src/copy";
import { MAX_DOCUMENT_BYTES, pickedFileProblem, slotRow } from "../web/src/present";
import { loadComponent } from "./helpers/web-components";
import { applicationView } from "./helpers/web-fixtures";

// The Documents card: the rules for one slot row (attached, uploading, error, submitted), what
// the card prints, and the request the page sends for a picked file.

const DocumentSlots = await loadComponent("components/DocumentSlots.tsx", "DocumentSlots");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const attached = (slot: DocumentRecord["slot"], fileRef: string) => ({ slot, file_ref: fileRef });
const stub = attached("pay_stub", "uploads/stub-oct.pdf");

describe("slot row rules", () => {
  it("an empty slot says so and offers Attach", () => {
    expect(slotRow("estimate", [], "draft")).toEqual({
      slot: "estimate",
      label: "Project estimate",
      fileName: null,
      actionLabel: "Attach",
      canPick: true,
      error: null,
    });
  });

  it("a slot with a file shows its name, whatever the folder in its reference, and offers Replace", () => {
    expect(slotRow("pay_stub", [stub], "draft")).toMatchObject({ fileName: "stub-oct.pdf", actionLabel: "Replace", canPick: true });
    expect(slotRow("pay_stub", [attached("pay_stub", "samples/paystub.pdf")], "draft").fileName).toBe("paystub.pdf");
    // Another slot's document does not count.
    expect(slotRow("estimate", [stub], "draft")).toMatchObject({ fileName: null, actionLabel: "Attach" });
  });

  it("while a file is on its way the control reads Uploading... and cannot be used, and the old file stays named", () => {
    expect(slotRow("pay_stub", [stub], "draft", { uploading: true, error: null })).toMatchObject({
      fileName: "stub-oct.pdf",
      actionLabel: UPLOADING_LABEL,
      canPick: false,
    });
    expect(UPLOADING_LABEL).toBe("Uploading...");
    expect(slotRow("estimate", [], "draft", { uploading: true, error: null })).toMatchObject({ fileName: null, canPick: false });
  });

  it("shows the server's sentence after a refusal and lets the contractor pick again", () => {
    expect(slotRow("estimate", [], "draft", { uploading: false, error: BAD_FILE_MESSAGE })).toMatchObject({
      actionLabel: "Attach",
      canPick: true,
      error: BAD_FILE_MESSAGE,
    });
    // A new attempt clears it; a row that is uploading has no error.
    expect(slotRow("estimate", [], "draft", { uploading: true, error: BAD_FILE_MESSAGE }).error).toBeNull();
  });

  it("after submission nothing can be picked and no old error is shown", () => {
    for (const status of ["documents_under_review", "documents_reviewed"] as const) {
      expect(slotRow("pay_stub", [stub], status, { uploading: false, error: "Something went wrong" })).toMatchObject({
        fileName: "stub-oct.pdf",
        actionLabel: "Replace",
        canPick: false,
        error: null,
      });
      expect(slotRow("estimate", [], status)).toMatchObject({ actionLabel: "Attach", canPick: false });
    }
  });
});

describe("picked files", () => {
  const file = (name: string, size: number, type: string) => ({ name, size, type });

  it("accepts a PDF up to 10 MB", () => {
    expect(pickedFileProblem(file("a.pdf", 1, "application/pdf"))).toBeNull();
    expect(pickedFileProblem(file("a.pdf", MAX_DOCUMENT_BYTES, "application/pdf"))).toBeNull();
    // Some systems leave the type empty.
    expect(pickedFileProblem(file("SCAN.PDF", 5000, ""))).toBeNull();
  });

  it("refuses anything else with the server's sentence", () => {
    expect(BAD_FILE_MESSAGE).toBe("Only PDF files up to 10 MB can be attached.");
    expect(pickedFileProblem(file("a.pdf", MAX_DOCUMENT_BYTES + 1, "application/pdf"))).toBe(BAD_FILE_MESSAGE);
    expect(pickedFileProblem(file("a.pdf", 0, "application/pdf"))).toBe(BAD_FILE_MESSAGE);
    expect(pickedFileProblem(file("photo.jpg", 5000, "image/jpeg"))).toBe(BAD_FILE_MESSAGE);
    expect(pickedFileProblem(file("notes", 5000, ""))).toBe(BAD_FILE_MESSAGE);
  });
});

describe("the Documents card", () => {
  const withDocuments = (documents: Array<{ slot: DocumentRecord["slot"]; file_ref: string }>, status: ApplicationView["status"] = "draft"): ApplicationView => ({
    ...applicationView({}, status),
    documents: documents.map((d, i) => ({
      id: `doc_${i + 1}`,
      application_id: "app_demo_001",
      slot: d.slot,
      file_ref: d.file_ref,
      pages: null,
      positioned_text_ref: null,
      adapter: "pdfjs" as const,
      extraction_status: "pending" as const,
    })),
  });
  const render = (view: ApplicationView) => renderToStaticMarkup(h(DocumentSlots, { view, onUpload: async () => undefined }));
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("shows No file attached and Attach for every empty slot", () => {
    const html = render(withDocuments([]));
    expect(html.split(NO_FILE_LABEL)).toHaveLength(4);
    expect(text(html)).toContain("Pay stub No file attached Attach Project estimate No file attached Attach Scope letter No file attached Attach");
    expect(html.split('accept="application/pdf"')).toHaveLength(4);
    expect(html).not.toContain("disabled");
  });

  it("shows the sample names with Replace controls after Load demo project", () => {
    const html = render(
      withDocuments([
        attached("pay_stub", "samples/paystub.pdf"),
        attached("estimate", "samples/estimate.pdf"),
        attached("scope_letter", "samples/scope_letter.pdf"),
      ]),
    );
    expect(text(html)).toContain(
      "Pay stub paystub.pdf Replace Project estimate estimate.pdf Replace Scope letter scope_letter.pdf Replace",
    );
    expect(html).not.toContain(NO_FILE_LABEL);
    expect(html).not.toContain("disabled");
  });

  it("disables every control once the application is submitted", () => {
    const html = render(withDocuments([attached("pay_stub", "uploads/stub-oct.pdf")], "documents_under_review"));
    expect(html.split("disabled=")).toHaveLength(4);
    expect(text(html)).toContain("Pay stub stub-oct.pdf Replace");
  });
});

describe("uploadDocument", () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the file itself as the body, as a PDF, with its encoded name and the session id", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => json(applicationView({})));
    vi.stubGlobal("fetch", fetchSpy);
    const api = await import("../web/src/api");
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "Résumé (1).pdf", { type: "application/pdf" });
    await api.uploadDocument("app_demo_001", "pay_stub", file);

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/applications/app_demo_001/documents/pay_stub");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(file);
    const headers = init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/pdf");
    expect(headers["x-file-name"]).toBe(encodeURIComponent("Résumé (1).pdf"));
    expect(headers["x-session-id"]).toBe(api.getSessionId());
  });

  it("throws the server's sentence when the file is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: "internal", message: BAD_FILE_MESSAGE, retryable: false }, 400)));
    const api = await import("../web/src/api");
    const file = new File(["not a pdf"], "a.pdf", { type: "application/pdf" });
    await expect(api.uploadDocument("app_demo_001", "estimate", file)).rejects.toMatchObject({
      name: "ApiError",
      message: BAD_FILE_MESSAGE,
      status: 400,
    });
  });
});
