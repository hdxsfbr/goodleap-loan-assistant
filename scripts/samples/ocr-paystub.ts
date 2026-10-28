// ocr-paystub.ts: one-time script that produces samples/paystub.ocr.json (plan items 41, 67, 71).
//
// It runs tesseract.js on the pay stub PNG that generate.ts rasterized, and writes the OCR result
// in the shape the ocr-fixture adapter reads:
//
//   { page_width, page_height, lines: [{ line, words: [{ text, bbox: { x0, y0, x1, y1 } | null, confidence }] }] }
//
// Boxes are in page pixels (the PNG is the whole page), `line` is 0-based from top to bottom and
// taken from tesseract's block / paragraph / line hierarchy, and words are in reading order.
// `confidence` is tesseract's word confidence divided by 100, so it is on the same 0 to 1 scale
// as the pdf.js adapter's fixed `confidence: 1`.
//
// RECORD OF THE ONE EDIT MADE TO THE OCR OUTPUT
//   After recognition, this script sets `bbox: null` on the words that make up the net pay figure
//   "1,812.40" (and on no other word). OCR engines emit words without geometry when they are
//   low-confidence; the null reproduces that for one value, so the sample demonstrates the
//   not-located path: the model's quote matches the indexed line text, but no box can be drawn.
//   Nothing else in the output is edited. (Dropping empty words and numbering the lines are not
//   edits to the recognized content.)
//   tesseract.js version: 7.0.0 (English model, page segmentation mode SINGLE_BLOCK)
//   Date of the edit:     2026-10-28
//
// Run:  npm run generate && npm run ocr   (run generate.ts first; it writes the PNG)
//       npm run ocr -- [--png <path>] [--out <path>] [--null-text <figure>] [--psm <mode>]
// Always run with stdin closed:  npm run ocr < /dev/null
// The process exits explicitly once the worker has terminated, so no timer keeps it open.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PSM, createWorker } from "tesseract.js";
import { DEFAULT_PNG, DEFAULT_SAMPLES_DIR, WORK_DIR, parseFlags } from "./common.js";

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface OcrWord {
  text: string;
  bbox: Box | null;
  confidence: number;
}
interface OcrLine {
  line: number;
  words: OcrWord[];
}
interface OcrFile {
  page_width: number;
  page_height: number;
  lines: OcrLine[];
}

/** Width and height of a PNG from its IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.subarray(1, 4).toString("latin1") !== "PNG") throw new Error("not a PNG file");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Comparable form of a figure: digits, comma and dot only. */
const figureKey = (s: string): string => s.replace(/[^0-9.,]/g, "");

/**
 * Sets bbox to null on the words that spell `figure`: one word, or the shortest run of consecutive
 * words on one line whose concatenation spells it. Exactly one such place must exist.
 */
function nullFigureBoxes(lines: OcrLine[], figure: string): { line: number; indexes: number[] } {
  const target = figureKey(figure);
  const hits: { line: number; indexes: number[] }[] = [];
  for (const l of lines) {
    for (let start = 0; start < l.words.length; start++) {
      let joined = "";
      for (let end = start; end < l.words.length; end++) {
        const part = figureKey(l.words[end]!.text);
        if (part === "") break; // a word with no figure characters is never part of the figure
        joined += part;
        if (joined === target) {
          hits.push({ line: l.line, indexes: Array.from({ length: end - start + 1 }, (_, k) => start + k) });
          break;
        }
        if (!target.startsWith(joined)) break;
      }
    }
  }
  if (hits.length !== 1) {
    throw new Error(`expected exactly one place where OCR spelled "${figure}", found ${hits.length}`);
  }
  const hit = hits[0]!;
  const target_line = lines.find((l) => l.line === hit.line)!;
  for (const i of hit.indexes) target_line.words[i]!.bbox = null;
  return hit;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2), {
    png: { value: true, description: "pay stub PNG written by generate.ts" },
    out: { value: true, description: "output JSON (default samples/paystub.ocr.json)" },
    "null-text": { value: true, description: "figure whose words lose their box (default 1,812.40)" },
    psm: { value: true, description: "tesseract page segmentation mode (default 6, single block)" },
  });
  const pngPath = path.resolve(String(flags.png ?? DEFAULT_PNG));
  const outPath = path.resolve(String(flags.out ?? path.join(DEFAULT_SAMPLES_DIR, "paystub.ocr.json")));
  const nullText = String(flags["null-text"] ?? "1,812.40");
  const psm = String(flags.psm ?? PSM.SINGLE_BLOCK) as PSM;

  const png = readFileSync(pngPath);
  const { width, height } = pngSize(png);
  const dpi = Math.round(width / 8.5); // the page is US Letter, 8.5 in wide

  mkdirSync(WORK_DIR, { recursive: true });
  // Language data is downloaded once into .work/ (git-ignored), not into the working directory.
  const worker = await createWorker("eng", undefined, { cachePath: WORK_DIR });
  let blocks;
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      user_defined_dpi: String(dpi),
    });
    const result = await worker.recognize(png, {}, { blocks: true });
    blocks = result.data.blocks;
  } finally {
    await worker.terminate();
  }
  if (!blocks) throw new Error("tesseract.js returned no block hierarchy");

  // Flatten block > paragraph > line > word, keeping tesseract's order, then number top to bottom.
  const found: { top: number; line: OcrLine }[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const tl of paragraph.lines) {
        const words: OcrWord[] = tl.words
          .filter((w) => w.text.trim() !== "")
          .map((w) => ({
            text: w.text.trim(),
            bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
            confidence: Math.round(w.confidence * 10) / 1000,
          }))
          .sort((a, b) => a.bbox!.x0 - b.bbox!.x0);
        if (words.length === 0) continue;
        found.push({ top: (tl.bbox.y0 + tl.bbox.y1) / 2, line: { line: -1, words } });
      }
    }
  }
  const sorted = [...found].sort((a, b) => a.top - b.top); // stable: ties keep hierarchy order
  if (sorted.some((s, i) => s !== found[i])) {
    console.warn("warning: tesseract's line order was not top to bottom; lines were re-sorted by vertical position");
  }
  const lines = sorted.map((s, i) => ({ ...s.line, line: i }));

  const hit = nullFigureBoxes(lines, nullText);

  const out: OcrFile = { page_width: width, page_height: height, lines };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${outPath}: ${lines.length} lines, ${lines.reduce((n, l) => n + l.words.length, 0)} words`);
  console.log(`bbox null on line ${hit.line}, word index(es) ${hit.indexes.join(",")} ("${nullText}")`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
