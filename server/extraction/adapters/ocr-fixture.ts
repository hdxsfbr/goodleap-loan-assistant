import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "../../versions.js";
import type { PositionedPage, PositionedText } from "../positioned-text.js";

// Adapter for the image-only pay stub: the committed OCR output in samples/. Its shape is
// { page_width, page_height, lines: [{ line, words: [{ text, bbox: { x0, y0, x1, y1 } | null,
// confidence }] }] } in page pixels. In production the Textract adapter (WORD and LINE blocks)
// produces the same PositionedText.

const OcrFileSchema = z.object({
  page_width: z.number().positive(),
  page_height: z.number().positive(),
  lines: z.array(
    z.object({
      line: z.number().int().nonnegative(),
      words: z.array(
        z.object({
          text: z.string(),
          bbox: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).nullable(),
          confidence: z.number(),
        }),
      ),
    }),
  ),
});

/** The OCR file that sits beside a sample PDF: `samples/paystub.pdf` -> `samples/paystub.ocr.json`. */
export function ocrPathFor(fileRef: string): string {
  const name = basename(fileRef).replace(/\.pdf$/i, "");
  return `${PROJECT_ROOT}samples/${name}.ocr.json`;
}

/** Converts parsed OCR output (page pixels) to positioned text (page fractions, top-left origin). */
export function ocrToPositionedText(raw: unknown): PositionedText {
  const ocr = OcrFileSchema.parse(raw);
  const page: PositionedPage = { page: 1, width: ocr.page_width, height: ocr.page_height, words: [] };
  for (const line of ocr.lines) {
    line.words.forEach((word, index) => {
      page.words.push({
        text: word.text,
        bbox: word.bbox
          ? {
              x: word.bbox.x0 / ocr.page_width,
              y: word.bbox.y0 / ocr.page_height,
              w: (word.bbox.x1 - word.bbox.x0) / ocr.page_width,
              h: (word.bbox.y1 - word.bbox.y0) / ocr.page_height,
            }
          : null,
        confidence: word.confidence,
        line: line.line,
        index,
      });
    });
  }
  return { pages: [page] };
}

export async function readOcrFixture(path: string): Promise<PositionedText> {
  return ocrToPositionedText(JSON.parse(await readFile(path, "utf8")));
}
