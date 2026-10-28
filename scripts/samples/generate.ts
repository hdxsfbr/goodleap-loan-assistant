// generate.ts: one-time script that builds the committed sample documents from
// samples/ground_truth.json (plan items 66, 67, 70).
//
//   estimate.pdf      text PDF (pdf-lib, standard fonts), readable by pdf.js
//   scope_letter.pdf  text PDF (pdf-lib, standard fonts), readable by pdf.js
//   paystub.pdf       image-only PDF: a pay stub is drawn as a PDF, page one is rasterized
//                     with pdfjs-dist and @napi-rs/canvas, and the PNG is embedded alone in a
//                     new single-page PDF, so there is no text layer to read
//
// It also leaves the rasterized PNG in .work/ (git-ignored) for ocr-paystub.ts.
//
// Run:  npm run generate -- [--samples-dir <dir>] [--png <path>] [--scale <n>]
// Run it with stdin closed in automation:  npm run generate < /dev/null
//
// All sample content is synthetic: fictional people, companies and an invented address.
// No Social Security number appears anywhere.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  DEFAULT_PNG,
  DEFAULT_SAMPLES_DIR,
  GroundTruth,
  SCRIPT_DIR,
  field,
  loadGroundTruth,
  parseFlags,
  parseMoneyCents,
} from "./common.js";

// ---------------------------------------------------------------------------------------------
// Content that is on the pages but is not a schema field. Kept here, and cross-checked against
// ground_truth.json in checkConsistency(), so the golden file stays exactly the schema fields.
// ---------------------------------------------------------------------------------------------

const HOMEOWNER = "Maria Lopez";
const PERIODS_PER_YEAR_BIWEEKLY = 26;
/** Pay periods paid so far in 2026 on the pay stub's calendar (periods start Mondays, 12/29/2025 first). */
const PERIODS_PAID_YTD = 21;
const PAY_DATE = "10/23/2026";

const DEDUCTIONS: { label: string; value: string }[] = [
  { label: "Federal Income Tax", value: "214.30" },
  { label: "Social Security", value: "145.70" },
  { label: "Medicare", value: "34.08" },
  { label: "State Income Tax", value: "143.52" },
];

const ESTIMATE_LINE_ITEMS: { description: string; amount: string }[] = [
  { description: "Tear-off and disposal of existing roof, 28 squares", amount: "$5,600.00" },
  { description: "Roof deck repair and synthetic underlayment", amount: "$4,400.00" },
  { description: "Architectural composition shingles, supply and install", amount: "$17,500.00" },
  { description: "Flashing, roof vents and ridge cap", amount: "$3,500.00" },
];

const SCOPE_LETTER_DATE = "September 21, 2026";
const SCOPE_LETTER_DETAILS = [
  "Remove and dispose of the existing roof covering down to the deck.",
  "Repair any damaged roof decking and install new synthetic underlayment.",
  "Install new flashing, roof vents and ridge cap.",
  "Install new architectural composition shingles over the whole roof.",
  "Clean the site and remove all debris when the work is finished.",
];

const FIXED_DATE = new Date("2026-10-28T12:00:00Z");
const PAGE_W = 612;
const PAGE_H = 792;

// ---------------------------------------------------------------------------------------------
// Consistency: the page content must agree with the golden values.
// ---------------------------------------------------------------------------------------------

function checkConsistency(gt: GroundTruth): void {
  const fail = (msg: string): never => {
    throw new Error(`ground_truth.json is inconsistent with the sample content: ${msg}`);
  };
  const cents = (slot: "pay_stub" | "estimate" | "scope_letter", id: string): number => {
    const f = field(gt, slot, id);
    if (f.cents === undefined) return fail(`${slot}.${id} has no cents`);
    if (parseMoneyCents(f.value) !== f.cents) fail(`${slot}.${id} value and cents disagree`);
    return f.cents;
  };

  const gross = cents("pay_stub", "gross_pay");
  const net = cents("pay_stub", "net_pay");
  const ytd = cents("pay_stub", "ytd_gross");
  const annualized = cents("pay_stub", "annualized_income");
  const deductions = DEDUCTIONS.reduce((sum, d) => sum + parseMoneyCents(d.value), 0);
  if (gross - deductions !== net) fail(`gross ${gross} - deductions ${deductions} != net ${net}`);
  if (field(gt, "pay_stub", "pay_frequency").normalized !== "biweekly") fail("pay frequency must be biweekly");
  if (gross * PERIODS_PER_YEAR_BIWEEKLY !== annualized) fail("annualized income is not gross x 26");
  if (gross * PERIODS_PAID_YTD !== ytd) fail(`ytd gross is not gross x ${PERIODS_PAID_YTD}`);

  const total = cents("estimate", "total_amount");
  const items = ESTIMATE_LINE_ITEMS.reduce((sum, i) => sum + parseMoneyCents(i.amount), 0);
  if (items !== total) fail(`line items sum to ${items}, total is ${total}`);
  if (field(gt, "estimate", "line_item_count").integer !== ESTIMATE_LINE_ITEMS.length) {
    fail("line_item_count disagrees with the line items");
  }
  if (field(gt, "estimate", "contractor_name").value !== field(gt, "scope_letter", "contractor_name").value) {
    fail("the estimate and the scope letter must name the same contractor");
  }
  for (const [slot, id] of [
    ["pay_stub", "pay_period_start"],
    ["pay_stub", "pay_period_end"],
    ["estimate", "estimate_date"],
    ["scope_letter", "start_date"],
  ] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(field(gt, slot, id).iso ?? "")) fail(`${slot}.${id} needs an iso date`);
  }
}

// ---------------------------------------------------------------------------------------------
// pdf-lib drawing helpers
// ---------------------------------------------------------------------------------------------

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

class Sheet {
  constructor(
    readonly page: PDFPage,
    readonly fonts: Fonts,
    readonly rightEdge: number,
  ) {}

  /** Draws text with its baseline `yTop` points below the top of the page; returns its width. */
  text(x: number, yTop: number, s: string, size: number, bold = false, gray = 0): number {
    const font = bold ? this.fonts.bold : this.fonts.regular;
    const width = font.widthOfTextAtSize(s, size);
    if (x + width > this.rightEdge) {
      throw new Error(`text overflows the right margin (${x + width} > ${this.rightEdge}): "${s}"`);
    }
    this.page.drawText(s, { x, y: PAGE_H - yTop, size, font, color: rgb(gray, gray, gray) });
    return width;
  }

  textRight(xRight: number, yTop: number, s: string, size: number, bold = false): void {
    const font = bold ? this.fonts.bold : this.fonts.regular;
    this.text(xRight - font.widthOfTextAtSize(s, size), yTop, s, size, bold);
  }

  rule(yTop: number, x0: number, x1: number, thickness = 0.75, gray = 0.55): void {
    this.page.drawLine({
      start: { x: x0, y: PAGE_H - yTop },
      end: { x: x1, y: PAGE_H - yTop },
      thickness,
      color: rgb(gray, gray, gray),
    });
  }

  /** Greedy word wrap; draws each line and returns the y of the next free line. */
  paragraph(x: number, yTop: number, s: string, size: number, maxWidth: number, leading: number): number {
    let y = yTop;
    let line = "";
    for (const word of s.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && this.fonts.regular.widthOfTextAtSize(candidate, size) > maxWidth) {
        this.text(x, y, line, size);
        y += leading;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) {
      this.text(x, y, line, size);
      y += leading;
    }
    return y;
  }
}

async function newDocument(title: string, author: string): Promise<{ pdf: PDFDocument; sheet: Sheet }> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(title);
  pdf.setAuthor(author);
  pdf.setCreator(author);
  pdf.setProducer("pdf-lib");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  return { pdf, sheet: new Sheet(page, fonts, PAGE_W - 48) };
}

// ---------------------------------------------------------------------------------------------
// The three documents
// ---------------------------------------------------------------------------------------------

async function buildEstimate(gt: GroundTruth): Promise<Uint8Array> {
  const contractor = field(gt, "estimate", "contractor_name").value;
  const { pdf, sheet } = await newDocument("Estimate", contractor);
  const left = 64;
  const right = PAGE_W - 64;
  const valueX = 172;

  sheet.text(left, 80, contractor, 24, true);
  sheet.text(left, 100, "Residential roofing and exteriors, San Jose, California", 11, false, 0.35);
  sheet.rule(114, left, right, 1.5, 0.2);

  sheet.text(left, 150, "ESTIMATE", 18, true);

  const rows: [string, string][] = [
    ["Estimate Date:", field(gt, "estimate", "estimate_date").value],
    ["Prepared for:", HOMEOWNER],
    ["Property:", field(gt, "scope_letter", "property_address").value],
    ["Project:", field(gt, "estimate", "project_description").value],
  ];
  let y = 182;
  for (const [label, value] of rows) {
    sheet.text(left, y, label, 11, true);
    sheet.text(valueX, y, value, 11);
    y += 20;
  }

  // Line item table.
  y += 22;
  sheet.text(left, y, "No.", 11, true);
  sheet.text(left + 40, y, "Description", 11, true);
  sheet.textRight(right, y, "Amount", 11, true);
  y += 8;
  sheet.rule(y, left, right);
  y += 20;
  ESTIMATE_LINE_ITEMS.forEach((item, i) => {
    sheet.text(left, y, String(i + 1), 11);
    sheet.text(left + 40, y, item.description, 11);
    sheet.textRight(right, y, item.amount, 11);
    y += 22;
  });
  sheet.rule(y - 8, left, right);

  // Totals block.
  y += 14;
  sheet.text(330, y, "Line items", 11);
  sheet.textRight(right, y, String(ESTIMATE_LINE_ITEMS.length), 11);
  y += 26;
  sheet.text(330, y, "Total Amount", 14, true);
  sheet.textRight(right, y, field(gt, "estimate", "total_amount").value, 14, true);

  y += 56;
  y = sheet.paragraph(
    left,
    y,
    "This estimate is valid for 30 days from the estimate date. Final scope and schedule are confirmed in the scope of work letter before work begins.",
    10,
    right - left,
    14,
  );
  sheet.text(left, y + 24, contractor, 11, true);

  return pdf.save();
}

async function buildScopeLetter(gt: GroundTruth): Promise<Uint8Array> {
  const contractor = field(gt, "scope_letter", "contractor_name").value;
  const address = field(gt, "scope_letter", "property_address").value;
  const [street, ...cityParts] = address.split(", ");
  const { pdf, sheet } = await newDocument("Scope of Work", contractor);
  const left = 72;
  const right = PAGE_W - 72;
  const valueX = 196;

  sheet.text(left, 80, contractor, 24, true);
  sheet.text(left, 100, "Residential roofing and exteriors, San Jose, California", 11, false, 0.35);
  sheet.rule(114, left, right, 1.5, 0.2);

  sheet.text(left, 150, SCOPE_LETTER_DATE, 11);
  sheet.text(left, 184, HOMEOWNER, 11);
  sheet.text(left, 200, street ?? address, 11);
  sheet.text(left, 216, cityParts.join(", "), 11);

  sheet.text(left, 252, "Re: Scope of work for your roof replacement", 12, true);

  let y = sheet.paragraph(
    left,
    286,
    "Dear Ms. Lopez, thank you for choosing us. This letter sets out the work we will carry out at your home and when we plan to begin.",
    11,
    right - left,
    16,
  );

  y += 12;
  const keyRows: [string, string][] = [
    ["Property address:", address],
    ["Scope of work:", field(gt, "scope_letter", "scope_summary").value],
    ["Estimated start date:", field(gt, "scope_letter", "start_date").value],
  ];
  for (const [label, value] of keyRows) {
    sheet.text(left, y, label, 11, true);
    sheet.text(valueX, y, value, 11);
    y += 22;
  }

  y += 14;
  sheet.text(left, y, "The work includes:", 11, true);
  y += 20;
  for (const detail of SCOPE_LETTER_DETAILS) {
    sheet.text(left + 12, y, "-", 11);
    sheet.text(left + 28, y, detail, 11);
    y += 18;
  }

  y += 14;
  y = sheet.paragraph(
    left,
    y,
    "Please call us with any questions before the start date. We will confirm the crew schedule with you the week before work begins.",
    11,
    right - left,
    16,
  );
  sheet.text(left, y + 20, "Sincerely,", 11);
  sheet.text(left, y + 56, contractor, 11, true);

  return pdf.save();
}

/**
 * The pay stub, drawn large and high contrast: pure black on white, big Helvetica, and each label
 * and its value on one line so OCR reads the key values exactly.
 */
async function buildPayStubSource(gt: GroundTruth): Promise<Uint8Array> {
  const employer = field(gt, "pay_stub", "employer_name").value;
  const { pdf, sheet } = await newDocument("Earnings Statement", employer);
  const left = 54;
  const right = PAGE_W - 54;
  const valueX = 290;
  const size = 17;
  const row = 34;

  sheet.text(left, 84, employer, 28, true);
  sheet.text(left, 116, "Earnings Statement", 18);
  sheet.rule(134, left, right, 2, 0);

  let y = 180;
  const line = (label: string, value: string, bold = false): void => {
    sheet.text(left, y, label, size, bold);
    sheet.text(valueX, y, value, size, bold);
    y += row;
  };
  const f = (id: string): string => field(gt, "pay_stub", id).value;

  line("Employee", HOMEOWNER);
  line("Pay Frequency", f("pay_frequency"));
  line("Pay Period Start", f("pay_period_start"));
  line("Pay Period End", f("pay_period_end"));
  line("Pay Date", PAY_DATE);

  y += 6;
  sheet.rule(y - 22, left, right, 2, 0);
  y += 12;
  line("Gross Pay", f("gross_pay"), true);
  for (const d of DEDUCTIONS) line(d.label, d.value);
  y += 6;
  sheet.rule(y - 26, left, right, 2, 0);
  y += 6;
  line("Net Pay", f("net_pay"), true);

  y += 6;
  sheet.rule(y - 26, left, right, 2, 0);
  y += 6;
  line("YTD Gross", f("ytd_gross"));

  return pdf.save();
}

// ---------------------------------------------------------------------------------------------
// Rasterize page one and wrap the PNG in an image-only PDF
// ---------------------------------------------------------------------------------------------

async function rasterizeFirstPage(
  pdfBytes: Uint8Array,
  scale: number,
): Promise<{ png: Buffer; width: number; height: number }> {
  // The pay stub uses the 14 standard PDF fonts, which are not embedded; pdf.js draws them from
  // its own font files.
  const standardFontDataUrl = path.join(SCRIPT_DIR, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;
  const task = pdfjs.getDocument({
    data: pdfBytes.slice(), // pdf.js takes ownership of the buffer
    standardFontDataUrl,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    // @napi-rs/canvas is DOM-compatible for what pdf.js uses; its types are not the DOM ones.
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    return { png: canvas.toBuffer("image/png"), width, height };
  } finally {
    await task.destroy();
  }
}

async function buildImageOnlyPdf(png: Buffer, title: string, author: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(title);
  pdf.setAuthor(author);
  pdf.setProducer("pdf-lib");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const image = await pdf.embedPng(png);
  page.drawImage(image, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
  return pdf.save();
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2), {
    "samples-dir": { value: true, description: "where ground_truth.json is read and the PDFs are written" },
    png: { value: true, description: "where the rasterized pay stub PNG is written for ocr-paystub.ts" },
    scale: { value: true, description: "rasterization scale; the page is 612 pt wide (default 3.5, 2142 px)" },
  });
  const samplesDir = path.resolve(String(flags["samples-dir"] ?? DEFAULT_SAMPLES_DIR));
  const pngPath = path.resolve(String(flags.png ?? DEFAULT_PNG));
  const scale = Number(flags.scale ?? 3.5);
  if (!(PAGE_W * scale >= 2000)) throw new Error(`scale ${scale} gives ${PAGE_W * scale} px; at least 2000 px wide is required`);

  const gt = loadGroundTruth(samplesDir);
  checkConsistency(gt);
  mkdirSync(samplesDir, { recursive: true });
  mkdirSync(path.dirname(pngPath), { recursive: true });

  const estimate = await buildEstimate(gt);
  const scopeLetter = await buildScopeLetter(gt);
  const payStubSource = await buildPayStubSource(gt);
  const { png, width, height } = await rasterizeFirstPage(payStubSource, scale);
  const payStub = await buildImageOnlyPdf(
    png,
    "Earnings Statement",
    field(gt, "pay_stub", "employer_name").value,
  );

  const outputs: [string, Uint8Array][] = [
    [path.join(samplesDir, "estimate.pdf"), estimate],
    [path.join(samplesDir, "scope_letter.pdf"), scopeLetter],
    [path.join(samplesDir, "paystub.pdf"), payStub],
    [pngPath, png],
  ];
  for (const [file, bytes] of outputs) {
    writeFileSync(file, bytes);
    console.log(`wrote ${file} (${bytes.length} bytes)`);
  }
  console.log(`pay stub PNG: ${width} x ${height} px at scale ${scale}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
