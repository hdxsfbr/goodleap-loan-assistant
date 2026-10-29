import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { CommandError } from "../../errors.js";
import { store } from "../../store.js";
import { PROJECT_ROOT } from "../../versions.js";
import type { DocumentsService, StoredFile } from "../types.js";

/** The bundled sample files the mock can serve, by file name. */
const SAMPLE_FILES: ReadonlySet<string> = new Set(["paystub.pdf", "estimate.pdf", "scope_letter.pdf"]);

/**
 * In-process stand-in for document management: serves the bundled sample files from `samples/`
 * by document id. Nothing is uploaded; a document's `file_ref` names one of the sample files, and
 * anything else is refused.
 */
export function createDocumentsMock(): DocumentsService {
  return {
    async getFile(documentId): Promise<StoredFile> {
      const doc = store.getDocument(documentId);
      if (!doc) throw new CommandError(`Document ${documentId} was not found.`, { status: 404 });
      const name = basename(doc.file_ref);
      if (!SAMPLE_FILES.has(name)) {
        throw new CommandError(`The file for document ${documentId} is not available.`, { status: 404 });
      }
      const bytes = new Uint8Array(await readFile(`${PROJECT_ROOT}samples/${name}`));
      return { file_ref: doc.file_ref, content_type: "application/pdf", bytes };
    },
  };
}
