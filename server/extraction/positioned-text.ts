import type { Box, PositionedWord as StoredWord } from "@shared/schemas";

// The one representation every text source produces (pdf.js, the committed OCR file, Textract in
// production) and the only input the extraction model receives: words in reading order, each with
// a box in page-relative fractions with a top-left origin, or no box at all when the source emitted
// text without geometry. The adapters own `line` (a number per page, top to bottom) and `index`
// (the word's position within its line).

export interface PositionedWord {
  text: string;
  /** Fractions of the page, top-left origin; null when the source gave the text no geometry. */
  bbox: Box | null;
  confidence: number;
  line: number;
  index: number;
}

export interface PositionedPage {
  /** 1-based. */
  page: number;
  width: number;
  height: number;
  /** Ordered by `line`, then `index`. */
  words: PositionedWord[];
}

export interface PositionedText {
  pages: PositionedPage[];
}

export interface PositionedLine {
  page: number;
  line: number;
  /** Ordered by `index`. */
  words: PositionedWord[];
}

/** The lines of one page in order. */
export function linesOfPage(page: PositionedPage): PositionedLine[] {
  const byLine = new Map<number, PositionedWord[]>();
  for (const word of page.words) {
    const words = byLine.get(word.line);
    if (words) words.push(word);
    else byLine.set(word.line, [word]);
  }
  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, words]) => ({
      page: page.page,
      line,
      words: [...words].sort((a, b) => a.index - b.index),
    }));
}

/** Every line of the document in reading order. */
export function allLines(text: PositionedText): PositionedLine[] {
  return [...text.pages].sort((a, b) => a.page - b.page).flatMap(linesOfPage);
}

export function pageOf(text: PositionedText, page: number): PositionedPage | undefined {
  return text.pages.find((p) => p.page === page);
}

export function wordCount(text: PositionedText): number {
  return text.pages.reduce((total, page) => total + page.words.length, 0);
}

/** The words of one line from token `start` to token `end`, both included, or undefined when the span does not exist. */
export function wordsInSpan(
  text: PositionedText,
  page: number,
  line: number,
  start: number,
  end: number,
): PositionedWord[] | undefined {
  const found = pageOf(text, page);
  if (!found || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return undefined;
  const words = linesOfPage(found).find((l) => l.line === line)?.words;
  if (!words) return undefined;
  const span = words.filter((w) => w.index >= start && w.index <= end);
  return span.length === end - start + 1 ? span : undefined;
}

function lineText(words: readonly PositionedWord[]): string {
  const widths = words.flatMap((w) => (w.bbox ? [w.bbox.w] : []));
  const average = widths.length > 0 ? widths.reduce((a, b) => a + b, 0) / widths.length : 0;
  let out = "";
  words.forEach((word, i) => {
    const previous = words[i - 1];
    if (previous) {
      // A word with no geometry keeps its place and is joined with a space, so it is visible.
      const gap = previous.bbox && word.bbox ? word.bbox.x - (previous.bbox.x + previous.bbox.w) : null;
      out += gap !== null && gap > average ? " | " : " ";
    }
    out += word.text;
  });
  return out;
}

/**
 * The document as the model reads it: one `p<page> L<line>: <text>` row per line, words in `index`
 * order, joined by " | " where the horizontal gap to the previous word is wider than one average
 * word on that line (a visible column gap) and by a space otherwise.
 */
export function toIndexedLines(text: PositionedText): string {
  return allLines(text)
    .map((l) => `p${l.page} L${String(l.line).padStart(2, "0")}: ${lineText(l.words)}`)
    .join("\n");
}

/** The union of the boxes of a run of words, or null when the run is empty or any word has no box. */
export function spanBox(words: readonly PositionedWord[]): Box | null {
  if (words.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const word of words) {
    if (!word.bbox) return null;
    left = Math.min(left, word.bbox.x);
    top = Math.min(top, word.bbox.y);
    right = Math.max(right, word.bbox.x + word.bbox.w);
    bottom = Math.max(bottom, word.bbox.y + word.bbox.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** A word in the form a proposal stores: the page and the token position travel with it. */
export function toStoredWord(word: PositionedWord, page: number): StoredWord {
  return {
    text: word.text,
    box: word.bbox ? { ...word.bbox } : null,
    confidence: word.confidence,
    page,
    line: word.line,
    token: word.index,
  };
}
