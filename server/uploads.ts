import type { DocumentRecord, DocumentSlot } from "@shared/schemas";
import type { Ctx } from "./audit-log.js";
import { attachDocument, replaceDocument, reserveDocumentId } from "./commands.js";
import { CommandError } from "./errors.js";
import { services, withMock } from "./services/index.js";
import { store } from "./store.js";

// The prototype's stand-in for the portal's document upload: a PDF the contractor picked is kept
// by the documents service and attached to its slot through the same command as the bundled
// samples. In production the portal's existing upload and its SQS message do this work.

/** The largest file the form accepts. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const BAD_FILE_MESSAGE = "Only PDF files up to 10 MB can be attached.";
export const NOT_DRAFT_MESSAGE = "Documents can be attached only before the application is submitted.";

const MAX_NAME_LENGTH = 120;
const PDF_MAGIC = "%PDF-";

/**
 * The file name to keep, from the `x-file-name` header: percent-decoded when the client encoded it,
 * reduced to its last path segment, stripped of control characters and cut to 120 characters
 * (keeping a short extension). A name that is empty after that becomes `<slot>.pdf`.
 */
export function sanitizeFileName(raw: string | undefined, slot: DocumentSlot): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded after all; use it as sent.
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, "");
  name = (name.split(/[\\/]/).pop() ?? "").trim();
  if (name === "" || /^\.+$/.test(name)) return `${slot}.pdf`;
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = `${name.slice(0, MAX_NAME_LENGTH - extension.length)}${extension}`;
  }
  return name;
}

/** Throws the 400 the form shows unless the bytes are a non-empty PDF within the size limit. */
export function requirePdf(bytes: unknown): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new CommandError(BAD_FILE_MESSAGE, { status: 400 });
  }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, PDF_MAGIC.length));
  if (head !== PDF_MAGIC) throw new CommandError(BAD_FILE_MESSAGE, { status: 400 });
}

/** Throws a 404 for an unknown application and a 409 once it has been submitted. */
export function requireOpenForUpload(applicationId: string): void {
  const application = store.getApplication(applicationId);
  if (!application) throw new CommandError(`Application ${applicationId} was not found.`, { status: 404 });
  if (application.status !== "draft") throw new CommandError(NOT_DRAFT_MESSAGE, { status: 409 });
}

/**
 * Attaches the picked file to the slot. The documents service keeps the bytes under a reserved
 * document id first, so a failed write leaves no record behind. A slot that already holds a document
 * is replaced (draft only, enforced by the command) and the old file is dropped. The reader is
 * always `pdfjs`: a file the contractor attached has no OCR fixture.
 */
export async function attachUpload(
  ctx: Ctx,
  slot: DocumentSlot,
  rawName: string | undefined,
  bytes: unknown,
): Promise<DocumentRecord> {
  requireOpenForUpload(ctx.application_id);
  requirePdf(bytes);
  const name = sanitizeFileName(rawName, slot);
  const current = store.listDocuments(ctx.application_id).find((d) => d.slot === slot);
  const documentId = reserveDocumentId();

  const stored = await withMock(
    ctx,
    "documents",
    "putFile",
    () => services.documents.putFile(documentId, name, bytes),
    { input: { document_id: documentId, file_name: name, size_bytes: bytes.byteLength } },
  );

  let document: DocumentRecord;
  try {
    const meta = { document_id: documentId };
    document = current
      ? replaceDocument(ctx, slot, stored.file_ref, "pdfjs", meta).document
      : attachDocument(ctx, slot, stored.file_ref, "pdfjs", meta).document;
  } catch (err) {
    await services.documents.removeFile(documentId).catch(() => undefined);
    throw err;
  }
  if (current) await services.documents.removeFile(current.id).catch(() => undefined);
  return document;
}
