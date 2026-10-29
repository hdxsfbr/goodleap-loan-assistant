import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PROJECT_ROOT } from "../../versions.js";
import type { PositionedPage, PositionedText, PositionedWord } from "../positioned-text.js";

// Adapter for a PDF that has no text layer (a scan or a picture): each page is drawn with pdf.js
// into a canvas, the picture is read by tesseract.js running in a worker thread, and the words come
// back as the same PositionedText the pdf.js and fixture adapters produce. The adapter owns line
// grouping: tesseract's own lines, numbered top to bottom per page, words left to right.
// In production the Textract adapter (WORD and LINE blocks) produces the same shape.

/** Pages are drawn at this multiple of the PDF's 72 points per inch (216 dpi for a letter page). */
const RENDER_SCALE = 3;
/** The longest side of a drawn page, in pixels; a larger page is drawn at a smaller scale. */
const MAX_SIDE_PX = 5000;

/** Tesseract's English model for the LSTM engine: the default of the tesseract.js worker. */
const LANG = "eng";
const LANG_PATH = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int";
/** Where the language data is kept after the first download. Under `data/`, which is not committed. */
export const TESSDATA_DIR = `${PROJECT_ROOT}data/tessdata`;
export const TESSDATA_FILE = join(TESSDATA_DIR, `${LANG}.traineddata`);
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface OcrOptions {
  /** Aborting stops the work: a page in the middle of recognition is cut off by ending the worker. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------------------------
// Loading the libraries
// ---------------------------------------------------------------------------------------------

type Tesseract = typeof import("tesseract.js");
type TesseractWorker = Awaited<ReturnType<Tesseract["createWorker"]>>;
type Napi = typeof import("@napi-rs/canvas");

async function loadTesseract(): Promise<Tesseract> {
  const mod = (await import("tesseract.js")) as Tesseract & { default?: Tesseract };
  return mod.default ?? mod;
}

let napiPromise: Promise<Napi> | undefined;

/**
 * The canvas library, with the globals pdf.js draws with (`DOMMatrix`, `Path2D`, `ImageData`)
 * taken from it: pdf.js 4.8 looks for them in the `canvas` package, which this project blocks.
 */
function loadCanvas(): Promise<Napi> {
  napiPromise ??= import("@napi-rs/canvas").then((napi) => {
    const globals = globalThis as Record<string, unknown>;
    globals.DOMMatrix ??= napi.DOMMatrix;
    globals.Path2D ??= napi.Path2D;
    globals.ImageData ??= napi.ImageData;
    return napi;
  });
  return napiPromise;
}

// ---------------------------------------------------------------------------------------------
// The worker: one per process, started on first use
// ---------------------------------------------------------------------------------------------

let workerPromise: Promise<TesseractWorker> | undefined;
/** The exit hook of each started worker, so ending a worker also removes its hook. */
const exitHooks = new Map<TesseractWorker, () => void>();

/** Downloads the language data once, into `data/tessdata/`, and returns when the file is there. */
async function ensureLanguageData(): Promise<void> {
  if (existsSync(TESSDATA_FILE)) return;
  console.log("Downloading OCR language data (about 3 MB, once)");
  const response = await fetch(`${LANG_PATH}/${LANG}.traineddata.gz`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The OCR language data download failed with status ${response.status}.`);
  const data = gunzipSync(Buffer.from(await response.arrayBuffer()));
  await mkdir(TESSDATA_DIR, { recursive: true });
  const partial = `${TESSDATA_FILE}.${process.pid}.part`;
  await writeFile(partial, data);
  await rename(partial, TESSDATA_FILE); // a half-written file is never taken for the data
}

interface WorkerThread {
  ref(): void;
  unref(): void;
  on(event: "error", listener: (err: unknown) => void): void;
}

/** The worker_threads handle behind a tesseract.js worker (the library keeps it as `worker`). */
function threadOf(worker: TesseractWorker): WorkerThread | undefined {
  return (worker as unknown as { worker?: WorkerThread }).worker;
}

/** Keeps the process alive while `work` runs on the worker thread, and lets go of it afterwards. */
async function holdThread<T>(worker: TesseractWorker, work: () => Promise<T>): Promise<T> {
  threadOf(worker)?.ref();
  try {
    return await work();
  } finally {
    threadOf(worker)?.unref();
  }
}

async function startWorker(): Promise<TesseractWorker> {
  await ensureLanguageData();
  const { createWorker, OEM, PSM } = await loadTesseract();
  // The worker would hang rather than fail if its language data could not be loaded, and would
  // throw out of a message handler on a recognition error; the handler turns both into a rejection.
  let fail: (reason: Error) => void = () => undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const worker = await Promise.race([
    createWorker(LANG, OEM.LSTM_ONLY, {
      langPath: LANG_PATH,
      cachePath: TESSDATA_DIR,
      errorHandler: (err: unknown) => fail(new Error(`The OCR engine reported: ${String(err)}`)),
    }),
    failed,
  ]);
  // A crash of the thread must not take the server down, and an idle worker must not keep the
  // process from ending (it is held only while a page is being read, see `holdThread`).
  const thread = threadOf(worker);
  thread?.on("error", (err) => {
    console.error("The OCR worker stopped:", err instanceof Error ? err.message : err);
    workerPromise = undefined; // the next call starts a new worker
  });
  // Page segmentation mode 6, "a single uniform block of text": keeps a table row on one line.
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  thread?.unref();
  const onExit = () => void worker.terminate();
  exitHooks.set(worker, onExit);
  process.once("exit", onExit);
  return worker;
}

function getWorker(): Promise<TesseractWorker> {
  workerPromise ??= startWorker().catch((err: unknown) => {
    workerPromise = undefined; // the next call tries again (the network may be back)
    throw err;
  });
  return workerPromise;
}

/** Ends the worker thread. The next OCR call starts a new one. Safe to call at any time. */
export async function shutdownOcr(): Promise<void> {
  const pending = workerPromise;
  workerPromise = undefined;
  if (!pending) return;
  let worker: TesseractWorker;
  try {
    worker = await pending;
  } catch {
    return; // a worker that never started has nothing to end
  }
  const onExit = exitHooks.get(worker);
  if (onExit) process.off("exit", onExit);
  exitHooks.delete(worker);
  await worker.terminate();
}

// ---------------------------------------------------------------------------------------------
// Drawing a page
// ---------------------------------------------------------------------------------------------

interface CanvasAndContext {
  canvas: { width: number; height: number } | null;
  context: unknown;
}

/** pdf.js 4.8 asks its canvas factory for the scratch canvases of masks, patterns and groups. */
function canvasFactoryFor(napi: Napi): new (options: unknown) => object {
  return class OcrCanvasFactory {
    constructor(_options: unknown) {}
    create(width: number, height: number): CanvasAndContext {
      if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
      const canvas = napi.createCanvas(width, height);
      return { canvas, context: canvas.getContext("2d") };
    }
    reset(target: CanvasAndContext, width: number, height: number): void {
      if (!target.canvas) throw new Error("Canvas is not specified");
      target.canvas.width = width;
      target.canvas.height = height;
    }
    destroy(target: CanvasAndContext): void {
      if (target.canvas) {
        target.canvas.width = 0;
        target.canvas.height = 0;
      }
      target.canvas = null;
      target.context = null;
    }
  };
}

interface RenderedPage {
  png: Buffer;
  width: number;
  height: number;
  /** Dots per inch of the picture, which tesseract uses to size the text. */
  dpi: number;
}

// ---------------------------------------------------------------------------------------------
// Tesseract's output as positioned words
// ---------------------------------------------------------------------------------------------

interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface OcrWordLike {
  text: string;
  confidence: number;
  bbox: OcrBox;
}
interface OcrLineLike {
  bbox: OcrBox;
  words: OcrWordLike[];
}
interface OcrBlockLike {
  paragraphs: Array<{ lines: OcrLineLike[] }>;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Maps tesseract's block, paragraph and line hierarchy to the words of one page. A line is a
 * tesseract line; lines are numbered by the vertical position of their center, top to bottom
 * (ties keep tesseract's order), and the words of a line run left to right. Words without text
 * are dropped. A box is kept as a fraction of the picture; a word whose box is empty or off the
 * picture keeps its text with no box.
 */
export function wordsOfBlocks(blocks: readonly OcrBlockLike[], width: number, height: number): PositionedWord[] {
  const found: Array<{ center: number; words: OcrWordLike[] }> = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const words = line.words
          .filter((w) => w.text.trim() !== "")
          .sort((a, b) => a.bbox.x0 - b.bbox.x0);
        if (words.length > 0) found.push({ center: (line.bbox.y0 + line.bbox.y1) / 2, words });
      }
    }
  }
  found.sort((a, b) => a.center - b.center);

  const out: PositionedWord[] = [];
  found.forEach((entry, line) => {
    entry.words.forEach((word, index) => {
      const x0 = clamp01(word.bbox.x0 / width);
      const y0 = clamp01(word.bbox.y0 / height);
      const x1 = clamp01(word.bbox.x1 / width);
      const y1 = clamp01(word.bbox.y1 / height);
      const usable = x1 > x0 && y1 > y0;
      out.push({
        text: word.text.trim(),
        bbox: usable ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null,
        confidence: clamp01(Math.round(word.confidence * 10) / 1000),
        line,
        index,
      });
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/** Rejects when the signal aborts; otherwise settles with `work`. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(signal.reason instanceof Error ? signal.reason : new Error("The OCR run was aborted."));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readDocument(file: Uint8Array, signal: AbortSignal | undefined): Promise<PositionedText> {
  signal?.throwIfAborted();
  const napi = await loadCanvas();
  // Loaded on first use, like the pdf.js text adapter: the library is heavy and most runs never need it.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({
    data: new Uint8Array(file),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
    CanvasFactory: canvasFactoryFor(napi),
    standardFontDataUrl: `${PROJECT_ROOT}node_modules/pdfjs-dist/standard_fonts/`,
    cMapUrl: `${PROJECT_ROOT}node_modules/pdfjs-dist/cmaps/`,
    cMapPacked: true,
  }).promise;
  try {
    const worker = await abortable(getWorker(), signal);
    const pages: PositionedPage[] = [];
    let dpi = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      signal?.throwIfAborted();
      const rendered = await renderPage(pdf, pageNumber, napi);
      signal?.throwIfAborted();
      // Ending the worker is the only way to stop a page that is being read; the next call starts a new one.
      const result = await holdThread(worker, async () => {
        if (rendered.dpi !== dpi) {
          await worker.setParameters({ user_defined_dpi: String(rendered.dpi) });
          dpi = rendered.dpi;
        }
        const reading = worker.recognize(rendered.png, {}, { blocks: true }).catch((err: unknown) => {
          // tesseract.js rejects with a bare string.
          throw err instanceof Error ? err : new Error(`The OCR engine failed: ${String(err)}`);
        });
        return abortable(reading, signal, () => {
          void shutdownOcr();
        });
      });
      pages.push({
        page: pageNumber,
        width: rendered.width,
        height: rendered.height,
        words: wordsOfBlocks(result.data.blocks ?? [], rendered.width, rendered.height),
      });
    }
    return { pages };
  } finally {
    await pdf.destroy();
  }
}

type PdfDocument = Awaited<ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;
/** The context pdf.js draws into; the server's type libraries have no DOM, so the canvas library's context is cast to it. */
type DrawingContext = Parameters<PdfPage["render"]>[0]["canvasContext"];

async function renderPage(pdf: PdfDocument, pageNumber: number, napi: Napi): Promise<RenderedPage> {
  const page = await pdf.getPage(pageNumber);
  try {
    const natural = page.getViewport({ scale: 1 });
    const scale = Math.min(RENDER_SCALE, MAX_SIDE_PX / Math.max(natural.width, natural.height));
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = napi.createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff"; // the page is drawn on white: a transparent background reads as black
    context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context as unknown as DrawingContext, viewport }).promise;
    const png = await canvas.encode("png");
    return { png, width, height, dpi: Math.round(scale * 72) };
  } finally {
    page.cleanup();
  }
}

// One document at a time: the single worker reads one picture at a time, and a second document
// waits its turn instead of racing the first for it.
let turn: Promise<unknown> = Promise.resolve();

/**
 * Reads a PDF with no text layer by OCR. Pages are numbered from 1, each with its lines in order;
 * a page with no words at all is allowed (a blank page). Throws when the bytes are not a readable
 * PDF, when the language data cannot be had, or when `options.signal` aborts.
 */
export function ocrTesseractAdapter(file: Uint8Array, options: OcrOptions = {}): Promise<PositionedText> {
  const run = turn.then(() => readDocument(file, options.signal));
  turn = run.catch(() => undefined);
  return abortable(run, options.signal);
}
