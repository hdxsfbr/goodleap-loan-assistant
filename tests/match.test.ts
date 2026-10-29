import { describe, expect, it } from "vitest";
import { locate, type Selection } from "../server/extraction/match.js";
import {
  spanBox,
  toIndexedLines,
  wordsInSpan,
  type PositionedPage,
  type PositionedText,
  type PositionedWord,
} from "../server/extraction/positioned-text.js";

// A small two-page document built by hand: row `line` sits at y = line * 0.05; each word is 0.1
// wide and starts at x = 0.1 + index * 0.15 unless a gap is given.

function word(
  text: string,
  line: number,
  index: number,
  options: { x?: number; w?: number; geometry?: boolean } = {},
): PositionedWord {
  const geometry = options.geometry ?? true;
  return {
    text,
    bbox: geometry ? { x: options.x ?? 0.1 + index * 0.15, y: line * 0.05, w: options.w ?? 0.1, h: 0.03 } : null,
    confidence: 0.95,
    line,
    index,
  };
}

const page1: PositionedPage = {
  page: 1,
  width: 612,
  height: 792,
  words: [
    word("Pay", 0, 0), word("Frequency", 0, 1), word("Biweekly", 0, 2, { x: 0.7 }),
    word("Gross", 1, 0), word("Pay", 1, 1), word("2,350.00", 1, 2, { x: 0.7 }), word("49,350.00", 1, 3, { x: 0.92, w: 0.07 }),
    word("Net", 2, 0), word("Pay", 2, 1), word("1,812.40", 2, 2, { geometry: false }),
    word("Gross", 3, 0), word("Pay", 3, 1), word("2,350.00", 3, 2, { x: 0.7 }),
  ],
};
const page2: PositionedPage = {
  page: 2,
  width: 612,
  height: 792,
  words: [word("Total", 0, 0), word("Amount", 0, 1), word("$31,000.00", 0, 2, { x: 0.7 })],
};
const doc: PositionedText = { pages: [page1, page2] };

function select(partial: Partial<Selection> & { value: string | null }): Selection {
  return {
    page: null,
    line: null,
    token_start: null,
    token_end: null,
    quoted_text: partial.value,
    ...partial,
  };
}

describe("locate", () => {
  it("takes the cited span when it equals the quote: method exact", () => {
    const result = locate(doc, select({ value: "2,350.00", page: 1, line: 1, token_start: 2, token_end: 2 }));
    expect(result.method).toBe("exact");
    expect(result.page).toBe(1);
    expect(result.words.map((w) => w.text)).toEqual(["2,350.00"]);
    expect(result.rejected_pointer).toBeUndefined();
  });

  it("compares through the normalizer: currency marks, case and spacing do not matter", () => {
    expect(locate(doc, select({ value: "$2,350.00", page: 1, line: 1, token_start: 2, token_end: 2 })).method).toBe("exact");
    const multi = locate(
      doc,
      select({ value: "gross", quoted_text: "GROSS   pay", page: 1, line: 1, token_start: 0, token_end: 1 }),
    );
    expect(multi.method).toBe("exact");
    expect(multi.words.map((w) => w.text)).toEqual(["Gross", "Pay"]);
  });

  it("accepts a quote that holds the value plus its label", () => {
    const result = locate(
      doc,
      select({ value: "2,350.00", quoted_text: "Gross Pay 2,350.00", page: 1, line: 1, token_start: 0, token_end: 2 }),
    );
    expect(result.method).toBe("exact");
    expect(result.words).toHaveLength(3);
  });

  it("falls back to a run on the cited page when the token span is wrong: method normalized", () => {
    const wrongTokens = locate(doc, select({ value: "2,350.00", page: 1, line: 1, token_start: 3, token_end: 3 }));
    expect(wrongTokens.method).toBe("normalized");
    expect(wrongTokens.words.map((w) => `${w.line}:${w.index}`)).toEqual(["1:2"]);

    const wrongLine = locate(doc, select({ value: "Biweekly", page: 1, line: 5, token_start: 0, token_end: 0 }));
    expect(wrongLine.method).toBe("normalized");
    expect(wrongLine.words[0]?.line).toBe(0);
  });

  it("prefers the cited line when the same figure appears on two lines", () => {
    const onThird = locate(doc, select({ value: "2,350.00", page: 1, line: 3, token_start: 9, token_end: 9 }));
    expect(onThird.method).toBe("normalized");
    expect(onThird.words[0]?.line).toBe(3);
    const noCitation = locate(doc, select({ value: "2,350.00" }));
    expect(noCitation.words[0]?.line).toBe(1);
  });

  it("searches the other pages when the cited page does not hold the quote: normalized, page 2", () => {
    const result = locate(doc, select({ value: "$31,000.00", page: 1, line: 0, token_start: 0, token_end: 0 }));
    expect(result.method).toBe("normalized");
    expect(result.page).toBe(2);
    expect(result.words.map((w) => w.text)).toEqual(["$31,000.00"]);
  });

  it("returns not_located with the words when the run has a word with no geometry", () => {
    const result = locate(doc, select({ value: "1,812.40", page: 1, line: 2, token_start: 2, token_end: 2 }));
    expect(result.method).toBe("not_located");
    expect(result.words.map((w) => w.text)).toEqual(["1,812.40"]);
    expect(result.page).toBe(1);
    expect(result.rejected_pointer).toBeUndefined();
    // The same holds when the model cited the wrong tokens and the run is found by search.
    const searched = locate(doc, select({ value: "1,812.40", page: 1, line: 0, token_start: 0, token_end: 0 }));
    expect(searched.method).toBe("not_located");
    expect(searched.words).toHaveLength(1);
  });

  it("rejects a quote that does not contain the value as a hallucinated pointer", () => {
    const result = locate(doc, select({ value: "9,999.00", quoted_text: "2,350.00", page: 1, line: 1, token_start: 2, token_end: 2 }));
    expect(result).toEqual({ method: "not_located", words: [], page: 1, rejected_pointer: true });
    // A value that sits inside a longer token is not contained either.
    expect(locate(doc, select({ value: "350.00", quoted_text: "2,350.00" })).rejected_pointer).toBe(true);
  });

  it("returns not_located with no words when the quote is nowhere in the document", () => {
    const result = locate(doc, select({ value: "2,999.00", quoted_text: "Gross Pay 2,999.00", page: 1, line: 1, token_start: 0, token_end: 2 }));
    expect(result).toEqual({ method: "not_located", words: [], page: 1 });
  });

  it("does not stitch a quote together across two lines", () => {
    const result = locate(doc, select({ value: "Biweekly Gross", quoted_text: "Biweekly Gross" }));
    expect(result.method).toBe("not_located");
    expect(result.words).toEqual([]);
  });

  it("yields not_extracted for a field the model returned as null", () => {
    expect(locate(doc, select({ value: null, quoted_text: null }))).toEqual({ method: "not_extracted", words: [], page: null });
  });

  it("does not keep a cited page the document does not have", () => {
    expect(locate(doc, select({ value: "2,999.00", quoted_text: "2,999.00", page: 7 })).page).toBeNull();
  });
});

describe("positioned text", () => {
  it("renders p<page> L<line> rows, with a column gap where the horizontal gap is wider than an average word", () => {
    const lines = toIndexedLines(doc).split("\n");
    expect(lines[0]).toBe("p1 L00: Pay Frequency | Biweekly");
    expect(lines[1]).toBe("p1 L01: Gross Pay | 2,350.00 | 49,350.00");
    expect(lines.at(-1)).toBe("p2 L00: Total Amount | $31,000.00");
  });

  it("keeps a word with no geometry in its place, joined by a space", () => {
    expect(toIndexedLines(doc).split("\n")[2]).toBe("p1 L02: Net Pay 1,812.40");
  });

  it("takes the union of the boxes of a run and null when a word has none", () => {
    const run = wordsInSpan(doc, 1, 1, 0, 1);
    expect(run?.map((w) => w.text)).toEqual(["Gross", "Pay"]);
    const box = spanBox(run ?? []);
    expect(box).not.toBeNull();
    expect(box?.x).toBeCloseTo(0.1);
    expect(box?.w).toBeCloseTo(0.25);
    expect(spanBox(wordsInSpan(doc, 1, 2, 1, 2) ?? [])).toBeNull();
    expect(spanBox([])).toBeNull();
  });

  it("finds no span for an index outside the line", () => {
    expect(wordsInSpan(doc, 1, 1, 2, 9)).toBeUndefined();
    expect(wordsInSpan(doc, 3, 1, 0, 0)).toBeUndefined();
    expect(wordsInSpan(doc, 1, 1, 2, 1)).toBeUndefined();
  });
});
