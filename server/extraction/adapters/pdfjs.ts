import type { PositionedPage, PositionedText, PositionedWord } from "../positioned-text.js";

// Adapter for text PDFs: the text layer of each page through the pdf.js legacy build, which runs
// in Node without a worker. In production the Textract adapter (WORD and LINE blocks) produces
// the same shape.

interface RawWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Room below the baseline for descenders and above the cap height, as fractions of the font size. */
const DESCENT = 0.2;
const ASCENT = 0.9;

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function isTextItem(item: unknown): item is TextItemLike {
  return typeof item === "object" && item !== null && "str" in item;
}

/**
 * Splits one text item into words and gives each a box. pdf.js reports one box per text run, not
 * per word, so a run's words are placed proportionally by character count across the run's width.
 * This is an approximation: it is exact for a monospaced run and within a few percent of a word's
 * width for proportional fonts, which is enough to draw a box around the right words.
 */
function wordsOfItem(
  item: TextItemLike,
  convert: (x: number, y: number) => number[],
): RawWord[] {
  const length = item.str.length;
  if (length === 0) return [];
  const originX = item.transform[4] ?? 0;
  const baseline = item.transform[5] ?? 0;
  const size = item.height > 0 ? item.height : Math.abs(item.transform[3] ?? 0);
  const words: RawWord[] = [];
  for (const match of item.str.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    const x0 = originX + (item.width * start) / length;
    const x1 = originX + (item.width * (start + match[0].length)) / length;
    const [ax, ay] = convert(x0, baseline - DESCENT * size);
    const [bx, by] = convert(x1, baseline + ASCENT * size);
    words.push({
      text: match[0],
      left: Math.min(ax ?? 0, bx ?? 0),
      top: Math.min(ay ?? 0, by ?? 0),
      width: Math.abs((bx ?? 0) - (ax ?? 0)),
      height: Math.abs((by ?? 0) - (ay ?? 0)),
    });
  }
  return words;
}

/**
 * Groups words into lines: sorted top to bottom, a word joins the current line when its vertical
 * center lies within half the average word height of the line's running center. Within a line the
 * words are ordered left to right.
 */
function groupLines(words: RawWord[]): RawWord[][] {
  if (words.length === 0) return [];
  const averageHeight = words.reduce((total, w) => total + w.height, 0) / words.length;
  const threshold = averageHeight / 2;
  const centered = words
    .map((word) => ({ word, center: word.top + word.height / 2 }))
    .sort((a, b) => a.center - b.center || a.word.left - b.word.left);
  const lines: Array<{ center: number; members: typeof centered }> = [];
  for (const entry of centered) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(entry.center - current.center) <= threshold) {
      current.members.push(entry);
      current.center = current.members.reduce((total, m) => total + m.center, 0) / current.members.length;
    } else {
      lines.push({ center: entry.center, members: [entry] });
    }
  }
  return lines.map((line) => line.members.sort((a, b) => a.word.left - b.word.left).map((m) => m.word));
}

/** Reads a text PDF into positioned text. Throws when the bytes are not a readable PDF. */
export async function readPdfText(data: Uint8Array): Promise<PositionedText> {
  // Loaded on first use: the library prints canvas polyfill warnings when it is imported, and the
  // server and the tests that never read a PDF should not see them.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const pdf = await loading.promise;
  try {
    const pages: PositionedPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const raw: RawWord[] = [];
      for (const item of content.items) {
        if (isTextItem(item)) {
          raw.push(...wordsOfItem(item, (x, y) => viewport.convertToViewportPoint(x, y)));
        }
      }
      const words: PositionedWord[] = [];
      groupLines(raw).forEach((lineWords, line) => {
        lineWords.forEach((word, index) => {
          words.push({
            text: word.text,
            bbox: {
              x: word.left / viewport.width,
              y: word.top / viewport.height,
              w: word.width / viewport.width,
              h: word.height / viewport.height,
            },
            confidence: 1,
            line,
            index,
          });
        });
      });
      pages.push({ page: pageNumber, width: viewport.width, height: viewport.height, words });
    }
    return { pages };
  } finally {
    await pdf.destroy();
  }
}
