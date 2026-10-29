import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CommandError } from "../../errors.js";
import { store } from "../../store.js";
import { PROJECT_ROOT } from "../../versions.js";
import type { DocumentsService, StoredFile } from "../types.js";

/** The bundled sample files the mock can serve, by file name. */
const SAMPLE_FILES: ReadonlySet<string> = new Set(["paystub.pdf", "estimate.pdf", "scope_letter.pdf"]);

/** Where files the contractor attached are kept: one `<document_id>.pdf` each. Not committed. */
export const UPLOADS_DIR = `${PROJECT_ROOT}data/uploads`;

/** The `file_ref` prefix that tells an attached file from a bundled sample. */
const UPLOAD_PREFIX = "uploads/";

const DOCUMENT_ID = /^doc_\d+$/;

export interface DocumentsMockOptions {
  /** Where attached files are written; `data/uploads` under the project by default. */
  uploadsDir?: string;
}

/**
 * In-process stand-in for document management. A document whose `file_ref` starts with `uploads/`
 * is a file the contractor attached: it is kept on local disk under the document's id. Any other
 * `file_ref` names one of the bundled sample files in `samples/`, and anything else is refused.
 */
export function createDocumentsMock(options: DocumentsMockOptions = {}): DocumentsService {
  const dir = options.uploadsDir ?? UPLOADS_DIR;
  const pathFor = (documentId: string): string => {
    if (!DOCUMENT_ID.test(documentId)) throw new CommandError(`${documentId} is not a document id.`, { status: 400 });
    return join(dir, `${documentId}.pdf`);
  };

  return {
    async getFile(documentId): Promise<StoredFile> {
      const doc = store.getDocument(documentId);
      if (!doc) throw new CommandError(`Document ${documentId} was not found.`, { status: 404 });
      if (doc.file_ref.startsWith(UPLOAD_PREFIX)) {
        try {
          return { file_ref: doc.file_ref, content_type: "application/pdf", bytes: new Uint8Array(await readFile(pathFor(doc.id))) };
        } catch {
          throw new CommandError(`The file for document ${documentId} is not available.`, { status: 404 });
        }
      }
      const name = basename(doc.file_ref);
      if (!SAMPLE_FILES.has(name)) {
        throw new CommandError(`The file for document ${documentId} is not available.`, { status: 404 });
      }
      const bytes = new Uint8Array(await readFile(`${PROJECT_ROOT}samples/${name}`));
      return { file_ref: doc.file_ref, content_type: "application/pdf", bytes };
    },

    async putFile(documentId, name, bytes) {
      const path = pathFor(documentId);
      await mkdir(dir, { recursive: true });
      await writeFile(path, bytes);
      return { file_ref: `${UPLOAD_PREFIX}${name}`, size_bytes: bytes.byteLength };
    },

    async removeFile(documentId) {
      await rm(pathFor(documentId), { force: true });
    },
  };
}
