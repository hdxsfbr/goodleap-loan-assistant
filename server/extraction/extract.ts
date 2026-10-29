import { fieldKeyFor, modelFields, parseAsWritten, schemaForSlot } from "@shared/document-schemas/index";
import type {
  DocumentRecord,
  ErrorCode,
  ExtractionStatus,
  FieldValue,
  MatchResult,
  ProposalSource,
} from "@shared/schemas";
import type { Ctx } from "../audit-log.js";
import { proposeFieldValue, setExtractionStatus } from "../commands.js";
import { config } from "../config.js";
import { AppError, CommandError, mapSdkError } from "../errors.js";
import { singleFlight } from "../review/single-flight.js";
import { openReviewTask } from "../review/tasks.js";
import { withMock, services } from "../services/index.js";
import { store } from "../store.js";
import { readOcrFixture, ocrPathFor } from "./adapters/ocr-fixture.js";
import { readPdfText } from "./adapters/pdfjs.js";
import { extractCall, fixtureCaller, type ModelCaller } from "./llm.js";
import { locate, type Selection } from "./match.js";
import {
  spanBox,
  toStoredWord,
  wordCount,
  type PositionedText,
} from "./positioned-text.js";
import { buildExtractionRequest, parseExtractionOutput, type ExtractionOutput } from "./prompt.js";

// The extraction consumer: the code a production SQS consumer would run. For each attached
// document it reads the positioned text through the document's adapter, asks the model to select
// each field (or replays the recorded response when there is no key), verifies every quote against
// the document's own words, and records one proposal per field for the reviewer. It never
// computes a derived value and never calls the discrepancy engine; those belong to the review path.

export type ExtractionMode = "live" | "fixture";

export interface ExtractDeps {
  /** `live` calls the model, `fixture` replays the recorded response. Default: live when a key is present. */
  mode?: ExtractionMode;
  /** Replaces the model call (tests). */
  call?: ModelCaller;
  /** Replaces the fixture file (tests). */
  fixturePath?: string;
  /** Wait before the single retry, in ms. Default 750. */
  retry_delay_ms?: number;
}

export interface FieldOutcome {
  field_key: string;
  match_method: MatchResult["method"];
  rejected_pointer: boolean;
  parse_error: string | null;
}

export interface ExtractionOutcome {
  document_id: string;
  extraction_status: ExtractionStatus;
  fields: FieldOutcome[];
  error_code: ErrorCode | null;
}

/** Errors worth one more attempt: the failure may not repeat. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "llm.timeout",
  "llm.rate_limited",
  "llm.server_error",
  "llm.schema_invalid",
]);

const DEFAULT_RETRY_DELAY_MS = 750;

/** What a field the model answered with `null` looks like to the matcher. */
const NOT_FOUND: Selection = {
  value: null,
  page: null,
  line: null,
  token_start: null,
  token_end: null,
  quoted_text: null,
};

/** The context for work the system does on its own behalf. */
export function systemCtx(applicationId: string, sessionId = "system"): Ctx {
  return { application_id: applicationId, session_id: sessionId, actor: { type: "system", id: "system" } };
}

/**
 * Reads the document into positioned text through its adapter: `pdfjs` reads the text layer of
 * the file the documents service holds, `ocr_fixture` reads the committed OCR output.
 */
export async function loadPositionedText(ctx: Ctx, doc: DocumentRecord): Promise<PositionedText> {
  if (doc.adapter === "ocr_fixture") return readOcrFixture(ocrPathFor(doc.file_ref));
  let bytes: Uint8Array = new Uint8Array();
  await withMock(
    ctx,
    "documents",
    "getFile",
    async () => {
      const file = await services.documents.getFile(doc.id);
      bytes = file.bytes;
      return { file_ref: file.file_ref, content_type: file.content_type, size_bytes: file.bytes.byteLength };
    },
    { input: { document_id: doc.id } },
  );
  return readPdfText(bytes);
}

function finish(
  ctx: Ctx,
  doc: DocumentRecord,
  status: ExtractionStatus,
  fields: FieldOutcome[],
  errorCode?: ErrorCode,
): ExtractionOutcome {
  setExtractionStatus(ctx, doc.id, status, {
    per_field: fields.map((f) => ({
      field_key: f.field_key,
      match_method: f.match_method,
      adapter: doc.adapter,
      ...(f.rejected_pointer ? { rejected_pointer: true } : {}),
      ...(f.parse_error === null ? {} : { parse_error: f.parse_error }),
    })),
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
  });
  return { document_id: doc.id, extraction_status: status, fields, error_code: errorCode ?? null };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Extracts one document. The outcome is recorded on the document (`done`, `failed` or
 * `type_mismatch`) with an `extraction.completed` event; a document that already left `pending` is
 * left alone. A call made while the document is already being read gets that run's outcome: the
 * model is asked once and the proposals are recorded once.
 */
export function extractDocument(
  ctx: Ctx,
  documentId: string,
  deps: ExtractDeps = {},
): Promise<ExtractionOutcome> {
  return singleFlight(ctx.application_id, `extract:${documentId}`, () => runExtraction(ctx, documentId, deps));
}

async function runExtraction(ctx: Ctx, documentId: string, deps: ExtractDeps): Promise<ExtractionOutcome> {
  const doc = store.getDocument(documentId);
  if (!doc || doc.application_id !== ctx.application_id) {
    throw new CommandError(`Document ${documentId} was not found.`, { status: 404 });
  }
  if (doc.extraction_status !== "pending") {
    return { document_id: doc.id, extraction_status: doc.extraction_status, fields: [], error_code: null };
  }
  const schema = schemaForSlot(doc.slot);

  let text: PositionedText;
  try {
    text = await loadPositionedText(ctx, doc);
  } catch (err) {
    console.error(`Extraction could not read ${doc.id}:`, err instanceof Error ? err.message : err);
    return finish(ctx, doc, "failed", [], "internal");
  }
  if (wordCount(text) === 0) return finish(ctx, doc, "failed", [], "internal");

  const request = buildExtractionRequest(schema, text);
  const mode: ExtractionMode = deps.mode ?? (config.hasLlmKey ? "live" : "fixture");
  const call = deps.call ?? (mode === "live" ? extractCall : fixtureCaller(doc.slot, deps.fixturePath));
  const attempts = deps.call === undefined && mode === "fixture" ? 1 : 2;

  let output: ExtractionOutput | undefined;
  let modelEventId: string | undefined;
  let modelId = "model";
  let failure: ErrorCode = "llm.schema_invalid";
  for (let attempt = 1; attempt <= attempts && output === undefined; attempt += 1) {
    try {
      const result = await call(ctx, request);
      const parsed = parseExtractionOutput(schema, result.text);
      if (parsed.ok && result.stop_reason !== "max_tokens") {
        output = parsed.output;
        modelEventId = result.event_id;
        modelId = result.model_id;
      } else {
        failure = "llm.schema_invalid";
      }
    } catch (err) {
      const mapped = mapSdkError(err);
      failure = mapped.code;
      if (!RETRYABLE.has(mapped.code)) break;
    }
    if (output === undefined && attempt < attempts) await sleep(deps.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS);
  }
  if (output === undefined || modelEventId === undefined) return finish(ctx, doc, "failed", [], failure);

  if (!output.document_matches_slot) {
    return finish(ctx, doc, "type_mismatch", [], "extraction.document_type_mismatch");
  }

  const modelCtx: Ctx = {
    ...ctx,
    actor: { type: "model", id: modelId },
    parent_event_id: modelEventId,
  };
  const fields: FieldOutcome[] = [];
  for (const field of modelFields(schema)) {
    const found = output.fields[field.id];
    if (found === undefined) continue;
    const selection: Selection = found ?? NOT_FOUND;
    const located = locate(text, selection);
    let value: FieldValue | null = null;
    let method = located.method;
    let parseError: string | null = null;
    if (selection.value !== null) {
      const parsed = parseAsWritten(field, selection.value);
      if (parsed.ok) {
        value = parsed.value;
      } else {
        // A value that does not parse is not a guess: the reviewer gets an empty row.
        method = "not_extracted";
        parseError = parsed.error;
      }
    }

    const quoted = selection.quoted_text ?? "";
    const source: ProposalSource =
      method === "not_extracted"
        ? { kind: "box", ref: { document_id: doc.id, page: null, bbox: null, words: [], quoted_text: quoted } }
        : {
            kind: "box",
            ref: {
              document_id: doc.id,
              page: located.page,
              bbox: spanBox(located.words),
              words: located.words.map((w) => toStoredWord(w, located.page ?? 1)),
              quoted_text: quoted,
            },
          };
    const rejected = located.rejected_pointer === true && method !== "not_extracted";
    const key = fieldKeyFor(doc.slot, field.id);
    proposeFieldValue(modelCtx, {
      field_key: key,
      value,
      source,
      match: { method, ...(rejected ? { rejected_pointer: true } : {}) },
    });
    fields.push({ field_key: key, match_method: method, rejected_pointer: rejected, parse_error: parseError });
  }
  return finish(ctx, doc, "done", fields);
}

/**
 * The in-process queue: extracts the attached documents in order, then opens the review task.
 * A document that cannot be processed at all is marked `failed` so the task can still open.
 * Called by the submit route after `submitApplication`, without waiting for it.
 */
export async function enqueueExtraction(
  ctx: Ctx,
  documentIds: readonly string[],
  deps: ExtractDeps = {},
): Promise<void> {
  for (const id of documentIds) {
    try {
      await extractDocument(ctx, id, deps);
    } catch (err) {
      console.error(`Extraction failed for ${id}:`, err instanceof Error ? err.message : err);
      if (store.getDocument(id)?.extraction_status === "pending") {
        const code: ErrorCode = err instanceof AppError ? err.code : "internal";
        setExtractionStatus(ctx, id, "failed", { error_code: code });
      }
    }
  }
  await openReviewTask(ctx, ctx.application_id, { manual: false });
}

/**
 * What the submit route runs after `submitApplication`: with extraction on, the documents go
 * through the queue and the task opens when they are done; with `EXTRACTION_ENABLED=false` the
 * task opens at once with every slot marked `manual` and no proposals.
 */
export async function startDocumentReview(
  ctx: Ctx,
  documentIds: readonly string[],
  deps: ExtractDeps = {},
): Promise<void> {
  if (config.extractionEnabled) {
    await enqueueExtraction(ctx, documentIds, deps);
  } else {
    await openReviewTask(ctx, ctx.application_id, { manual: true });
  }
}

// Re-exported so the submit route imports the whole after-submit surface from one module.
export { openReviewTask } from "../review/tasks.js";
