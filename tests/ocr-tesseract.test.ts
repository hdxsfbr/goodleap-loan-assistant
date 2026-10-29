import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ocrToPositionedText } from "../server/extraction/adapters/ocr-fixture.js";
import { ocrTesseractAdapter, shutdownOcr, wordsOfBlocks } from "../server/extraction/adapters/ocr-tesseract.js";
import { allLines, wordCount, type PositionedText, type PositionedWord } from "../server/extraction/positioned-text.js";
import { ocrUnavailableReason } from "./helpers/ocr.js";
import { simplePdf } from "./helpers/pdf.js";

// The OCR adapter. The first block maps tesseract's output without the engine. The second runs the
// real engine on the committed pay stub, a picture with no text layer, and compares the result
// with the recorded OCR output the demo uses.

const samples = join(import.meta.dirname, "..", "samples");

describe("mapping tesseract output to positioned words", () => {
  const word = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 96.4) => ({
    text,
    confidence,
    bbox: { x0, y0, x1, y1 },
  });
  const line = (words: ReturnType<typeof word>[], y0: number, y1: number) => ({
    words,
    bbox: { x0: 0, y0, x1: 1000, y1 },
  });

  it("numbers lines top to bottom across blocks, orders words left to right and scales boxes to fractions", () => {
    const words = wordsOfBlocks(
      [
        { paragraphs: [{ lines: [line([word("Total", 100, 400, 200, 440)], 400, 440)] }] },
        {
          paragraphs: [
            { lines: [line([word("Pay", 300, 100, 360, 140), word("Gross", 100, 100, 250, 140)], 100, 140)] },
          ],
        },
      ],
      1000,
      2000,
    );
    expect(words.map((w) => [w.text, w.line, w.index])).toEqual([
      ["Gross", 0, 0],
      ["Pay", 0, 1],
      ["Total", 1, 0],
    ]);
    const box = words[0]?.bbox;
    expect([box?.x, box?.y, box?.w, box?.h].map((n) => Number(n?.toFixed(6)))).toEqual([0.1, 0.05, 0.15, 0.02]);
    expect(words[0]?.confidence).toBe(0.964);
  });

  it("drops words with no text and gives a word with an empty box no box", () => {
    const words = wordsOfBlocks(
      [
        {
          paragraphs: [
            {
              lines: [
                line([word("  ", 0, 0, 10, 10), word("Net", 10, 10, 50, 30), word("1,812.40", 60, 10, 60, 30)], 10, 30),
                line([word("", 0, 50, 10, 60)], 50, 60),
              ],
            },
          ],
        },
      ],
      100,
      100,
    );
    expect(words.map((w) => w.text)).toEqual(["Net", "1,812.40"]);
    expect(words[0]?.bbox).not.toBeNull();
    expect(words[1]?.bbox).toBeNull();
    expect(words.every((w) => w.line === 0)).toBe(true);
  });

  it("keeps boxes inside the page", () => {
    const [only] = wordsOfBlocks([{ paragraphs: [{ lines: [line([word("Edge", -5, -5, 120, 130)], 0, 130)] }] }], 100, 100);
    expect(only?.bbox).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

const near = (a: PositionedWord, b: PositionedWord): boolean => {
  if (!a.bbox || !b.bbox) return false;
  const dx = a.bbox.x + a.bbox.w / 2 - (b.bbox.x + b.bbox.w / 2);
  const dy = a.bbox.y + a.bbox.h / 2 - (b.bbox.y + b.bbox.h / 2);
  return Math.abs(dx) <= 0.02 && Math.abs(dy) <= 0.02;
};

describe("the tesseract adapter on the engine", () => {
  let skipReason: string | null = null;
  beforeAll(async () => {
    skipReason = await ocrUnavailableReason();
  }, 180_000);
  afterAll(async () => {
    await shutdownOcr();
  });

  let stub: PositionedText | undefined;
  async function payStub(): Promise<PositionedText> {
    stub ??= await ocrTesseractAdapter(readFileSync(join(samples, "paystub.pdf")));
    return stub;
  }

  it("reads the pay stub picture into located words, with the key figures inside the page", async (ctx) => {
    if (skipReason) return ctx.skip();
    const text = await payStub();
    expect(text.pages).toHaveLength(1);
    expect(text.pages[0]).toMatchObject({ page: 1 });
    const all = text.pages[0]?.words ?? [];
    for (const wanted of ["Pinecrest", "Biweekly", "2,350.00", "49,350.00"]) {
      const found = all.filter((w) => w.text === wanted);
      expect(found, wanted).toHaveLength(1);
      const box = found[0]?.bbox;
      expect(box, `${wanted} has a box`).not.toBeNull();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect(box?.y).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.w ?? 0)).toBeLessThanOrEqual(1);
      expect((box?.y ?? 0) + (box?.h ?? 0)).toBeLessThanOrEqual(1);
      expect(box?.w).toBeGreaterThan(0);
      expect(box?.h).toBeGreaterThan(0);
    }
    expect(all.every((w) => w.text.trim() !== "" && w.confidence >= 0 && w.confidence <= 1)).toBe(true);
  }, 180_000);

  it("puts Gross, Pay and 2,350.00 on one line, in order", async (ctx) => {
    if (skipReason) return ctx.skip();
    const text = await payStub();
    const row = allLines(text).find((l) => l.words.some((w) => w.text === "2,350.00"));
    expect(row?.words.map((w) => w.text)).toEqual(["Gross", "Pay", "2,350.00"]);
    expect(row?.words.map((w) => w.index)).toEqual([0, 1, 2]);
    // Reading order: the rows run top to bottom.
    const tops = allLines(text).map((l) => l.words[0]?.bbox?.y ?? 0);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
  }, 180_000);

  it("agrees with the recorded OCR output: at least 90% of its located words, centers within 0.02", async (ctx) => {
    if (skipReason) return ctx.skip();
    const text = await payStub();
    const recorded = ocrToPositionedText(JSON.parse(readFileSync(join(samples, "paystub.ocr.json"), "utf8")));
    const expected = (recorded.pages[0]?.words ?? []).filter((w) => w.bbox !== null);
    const actual = text.pages[0]?.words ?? [];
    const matched = expected.filter((e) => actual.some((a) => a.text === e.text && near(a, e)));
    const score = matched.length / expected.length;
    console.log(`OCR against the recorded output: ${matched.length} of ${expected.length} located words matched (${(score * 100).toFixed(1)}%)`);
    const missed = expected.filter((e) => !matched.includes(e)).map((e) => e.text);
    expect(score, `missed: ${missed.join(", ")}`).toBeGreaterThanOrEqual(0.9);
    expect(expected.length).toBeGreaterThanOrEqual(40);
  }, 180_000);

  it("numbers the pages of a document and allows a page with no words", async (ctx) => {
    if (skipReason) return ctx.skip();
    const text = await ocrTesseractAdapter(simplePdf(["Hello first page", null, "Closing remarks"]));
    expect(text.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(text.pages[1]?.words).toEqual([]);
    expect(text.pages[0]?.words.map((w) => w.text).join(" ")).toContain("first");
    expect(text.pages[2]?.words.map((w) => w.text).join(" ")).toContain("remarks");
    expect(wordCount(text)).toBeGreaterThanOrEqual(4);
    const lines = allLines(text);
    expect(lines.map((l) => l.page)).toEqual([1, 3]);
    expect(lines.map((l) => l.line)).toEqual([0, 0]);
  }, 180_000);

  it("stops when the caller gives up, and reads the next document afterwards", async (ctx) => {
    if (skipReason) return ctx.skip();
    const controller = new AbortController();
    const reading = ocrTesseractAdapter(readFileSync(join(samples, "estimate.pdf")), { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("gave up")), 100); // while the page is drawn or read
    await expect(reading).rejects.toThrow("gave up");
    await expect(ocrTesseractAdapter(simplePdf(["Still working"]))).resolves.toBeDefined();
  }, 180_000);

  it("refuses bytes that are not a PDF", async (ctx) => {
    if (skipReason) return ctx.skip();
    await expect(ocrTesseractAdapter(Buffer.from("not a pdf"))).rejects.toThrow();
  }, 180_000);
});
