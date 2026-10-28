// verify.ts: checks the committed sample artifacts against samples/ground_truth.json.
//
//   - text PDFs: pdf.js extracts text, and every golden value sits on a single extracted line
//   - image PDF: one page, one image of at least 2000 px, and no text layer at all
//   - paystub.ocr.json: item 41 shape, 0-based consecutive lines, words in x order, the golden
//     values present as single tokens on one line, `bbox: null` on exactly the net pay words and a
//     box on every other word
//   - no Social Security number pattern in any extracted or recognized text
//
// Run:  npm run verify -- [--samples-dir <dir>]      (stdin closed in automation: < /dev/null)
// Exits 1 when any check fails.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { DEFAULT_SAMPLES_DIR, SCRIPT_DIR, field, loadGroundTruth, parseFlags } from "./common.js";

let failures = 0;
const check = (ok: boolean, what: string, detail = ""): void => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  ${detail}` : ""}`);
};

const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
/** Size of the PNG that generate.ts leaves in .work/ (git-ignored); null when it has not been generated. */
function pngSize(): { width: number; height: number } | null {
  const file = path.join(SCRIPT_DIR, ".work", "paystub.png");
  if (!existsSync(file)) return null;
  const png = readFileSync(file);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

async function openPdf(file: string) {
  return pdfjs.getDocument({
    data: new Uint8Array(readFileSync(file)),
    standardFontDataUrl: path.join(SCRIPT_DIR, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep,
  }).promise;
}

/** Extracted text lines for each page: items grouped by baseline, joined in x order. */
async function textLines(file: string): Promise<{ pages: number; lines: string[] }> {
  const doc = await openPdf(file);
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items) {
      if (!("str" in item) || item.str.trim() === "") continue;
      const y = Math.round(item.transform[5] ?? 0);
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      const row = rows.get(key) ?? [];
      row.push({ x: item.transform[4] ?? 0, str: item.str });
      rows.set(key, row);
    }
    [...rows.entries()]
      .sort((a, b) => b[0] - a[0]) // PDF y grows upward
      .forEach(([, row]) => lines.push(squash(row.sort((a, b) => a.x - b.x).map((r) => r.str).join(" "))));
  }
  const pages = doc.numPages;
  return { pages, lines };
}

async function verifyTextPdf(samplesDir: string, file: string, slot: "estimate" | "scope_letter"): Promise<void> {
  const gt = loadGroundTruth(samplesDir)[slot];
  const { pages, lines } = await textLines(path.join(samplesDir, file));
  console.log(`\n${file}: ${pages} page(s), ${lines.length} extracted lines`);
  check(pages === 1, `${file} has one page`);
  for (const [id, f] of Object.entries(gt)) {
    if (f.derived) continue;
    if (id === "line_item_count") {
      const row = lines.find((l) => /^Line items\b/.test(l));
      check(row !== undefined && row.endsWith(` ${f.value}`), `${slot}.${id} = ${f.value}`, row ? `line: "${row}"` : "no 'Line items' line");
      continue;
    }
    const row = lines.find((l) => l.includes(squash(f.value)));
    check(row !== undefined, `${slot}.${id} on one extracted line`, row ? `line: "${row}"` : `missing: "${f.value}"`);
  }
  check(!lines.some((l) => SSN.test(l)), `${file} has no SSN pattern`);
}

async function verifyImagePdf(samplesDir: string): Promise<void> {
  const file = path.join(samplesDir, "paystub.pdf");
  const doc = await openPdf(file);
  console.log(`\npaystub.pdf: ${doc.numPages} page(s)`);
  check(doc.numPages === 1, "paystub.pdf has one page");
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items.filter((i) => "str" in i && i.str.trim() !== "");
  check(text.length === 0, "paystub.pdf has no text layer", `${text.length} text items`);
  const ops = await page.getOperatorList();
  const imageOps = [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject];
  const images = ops.fnArray.filter((fn) => imageOps.includes(fn)).length;
  check(images === 1, "paystub.pdf paints exactly one image", `${images} image paint operation(s)`);
  const size = pngSize();
  if (size) check(size.width >= 2000, "pay stub PNG is at least 2000 px wide", `${size.width} x ${size.height}`);
}

interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  confidence: number;
}
interface OcrFile {
  page_width: number;
  page_height: number;
  lines: { line: number; words: OcrWord[] }[];
}

function verifyOcr(samplesDir: string): void {
  const gt = loadGroundTruth(samplesDir).pay_stub;
  const ocr = JSON.parse(readFileSync(path.join(samplesDir, "paystub.ocr.json"), "utf8")) as OcrFile;
  console.log(`\npaystub.ocr.json: ${ocr.page_width} x ${ocr.page_height}, ${ocr.lines.length} lines`);

  const size = pngSize();
  if (size) check(ocr.page_width === size.width && ocr.page_height === size.height, "page size matches the PNG");
  check(ocr.page_width >= 2000, "page is at least 2000 px wide");
  check(ocr.lines.every((l, i) => l.line === i), "lines are numbered 0..n-1 in order");
  check(ocr.lines.every((l) => l.words.length > 0), "no empty lines");
  check(
    ocr.lines.every((l) => l.words.every((w, i) => i === 0 || !w.bbox || !l.words[i - 1]!.bbox || w.bbox.x0 >= l.words[i - 1]!.bbox!.x0)),
    "words are in left to right order",
  );
  check(
    ocr.lines.every((l) => l.words.every((w) => w.confidence >= 0 && w.confidence <= 1)),
    "confidence is on a 0 to 1 scale",
  );

  const tokens = (l: { words: OcrWord[] }): string[] => l.words.map((w) => w.text);
  const lineWith = (token: string, ignoreCase = false) =>
    ocr.lines.filter((l) => tokens(l).some((t) => (ignoreCase ? t.toLowerCase() === token.toLowerCase() : t === token)));

  const keys: [string, string[], string, boolean][] = [
    ["gross_pay", [gt.gross_pay!.value], "Gross", false],
    ["net_pay", [gt.net_pay!.value], "Net", false],
    ["ytd_gross", [gt.ytd_gross!.value], "YTD", false],
    ["pay_period_start", [gt.pay_period_start!.value], "Start", false],
    ["pay_period_end", [gt.pay_period_end!.value], "End", false],
    ["pay_frequency", [gt.pay_frequency!.value], "Frequency", true],
    ["employer_name", gt.employer_name!.value.split(" "), "", false],
  ];
  for (const [id, words, anchor, ignoreCase] of keys) {
    const sets = words.map((w) => lineWith(w, ignoreCase));
    const first = sets[0]!;
    const sameLine = first.find((l) => sets.every((s) => s.includes(l)));
    const anchored = anchor === "" || (sameLine !== undefined && tokens(sameLine).includes(anchor));
    check(
      sameLine !== undefined && sets.every((s) => s.length === 1) && anchored,
      `pay_stub.${id} as single token(s) on one line`,
      sameLine ? `L${sameLine.line}: ${tokens(sameLine).join(" | ")}` : `missing: ${words.join(" ")}`,
    );
  }

  const nullWords = ocr.lines.flatMap((l) => l.words.filter((w) => w.bbox === null).map((w) => ({ line: l.line, text: w.text })));
  check(
    nullWords.length === 1 && nullWords[0]!.text === gt.net_pay!.value,
    "bbox is null on exactly the net pay word(s)",
    JSON.stringify(nullWords),
  );
  const boxes = ocr.lines.flatMap((l) => l.words.filter((w) => w.bbox !== null).map((w) => w.bbox!));
  check(
    boxes.every((b) => b.x1 > b.x0 && b.y1 > b.y0 && b.x0 >= 0 && b.y0 >= 0 && b.x1 <= ocr.page_width && b.y1 <= ocr.page_height),
    "every other word has a box inside the page",
    `${boxes.length} boxes`,
  );
  const allText = ocr.lines.map((l) => tokens(l).join(" "));
  check(!allText.some((l) => SSN.test(l)), "OCR text has no SSN pattern");

  const derived = field(loadGroundTruth(samplesDir), "pay_stub", "annualized_income");
  check(derived.cents === gt.gross_pay!.cents! * 26, "annualized income is gross x 26", `${derived.cents} cents`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2), {
    "samples-dir": { value: true, description: "folder holding the committed sample artifacts" },
  });
  const samplesDir = path.resolve(String(flags["samples-dir"] ?? DEFAULT_SAMPLES_DIR));
  await verifyTextPdf(samplesDir, "estimate.pdf", "estimate");
  await verifyTextPdf(samplesDir, "scope_letter.pdf", "scope_letter");
  await verifyImagePdf(samplesDir);
  verifyOcr(samplesDir);
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
}

main().then(
  () => process.exit(failures === 0 ? 0 : 1),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
