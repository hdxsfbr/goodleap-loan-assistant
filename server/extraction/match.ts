import { normalizeText } from "@shared/normalize";
import type { MatchMethod } from "@shared/schemas";
import {
  linesOfPage,
  pageOf,
  spanBox,
  wordsInSpan,
  type PositionedText,
  type PositionedWord,
} from "./positioned-text.js";

// Quote-to-span matching for the extraction. The model selects an indexed span of the document's
// own text and quotes it; this module verifies the quote and returns the words it stands for, so
// the box is drawn from the document's own word positions and never from a model claim. Two tiers
// and no heuristics: the quote equals the cited span after normalization, or it equals a run of
// consecutive words on one line somewhere on the cited page, then on any page, after
// normalization. Anything else is not located. There is no score. Every comparison goes through
// shared/normalize.ts.

/** What the model returned for one field. A missing field has every member null. */
export interface Selection {
  /** The value as written on the document. */
  value: string | null;
  page: number | null;
  line: number | null;
  token_start: number | null;
  /** The last token of the span, included. */
  token_end: number | null;
  quoted_text: string | null;
}

export interface LocateResult {
  method: MatchMethod;
  /** The matched words: empty unless a run was found (a run without geometry is kept here). */
  words: PositionedWord[];
  /** The page the words are on, else the page the model cited when the document has it, else null. */
  page: number | null;
  /** True when the quote does not contain the value: a pointer to something the value is not in. */
  rejected_pointer?: boolean;
}

function tokensOf(s: string): string[] {
  const normalized = normalizeText(s);
  return normalized === "" ? [] : normalized.split(" ");
}

function wordTokens(words: readonly PositionedWord[]): string[] {
  return words.flatMap((w) => tokensOf(w.text));
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

/** True when `needle` appears in `haystack` as consecutive tokens. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((token, k) => haystack[i + k] === token)) return true;
  }
  return false;
}

/**
 * The first run of consecutive words on one line whose normalized text equals the quote. Words
 * that normalize to nothing (a bare "|" or "-") may sit inside a run but never start or end one.
 */
function findRun(words: readonly PositionedWord[], quote: readonly string[]): PositionedWord[] | undefined {
  const normalized = words.map((word) => tokensOf(word.text).join(" "));
  for (let start = 0; start < words.length; start += 1) {
    if (normalized[start] !== quote[0]) continue;
    let matched = 0;
    for (let i = start; i < words.length; i += 1) {
      const token = normalized[i] ?? "";
      if (token === "") continue;
      if (token !== quote[matched]) break;
      matched += 1;
      if (matched === quote.length) return words.slice(start, i + 1);
    }
  }
  return undefined;
}

function located(method: "exact" | "normalized", words: PositionedWord[], page: number): LocateResult {
  // A run whose words carry no geometry verified the quote but cannot be drawn.
  return spanBox(words) === null ? { method: "not_located", words, page } : { method, words, page };
}

/** Verifies one selection against the document's positioned text. */
export function locate(text: PositionedText, selection: Selection): LocateResult {
  if (selection.value === null) return { method: "not_extracted", words: [], page: null };

  const cited = selection.page !== null && pageOf(text, selection.page) ? selection.page : null;
  const quote = tokensOf(selection.quoted_text ?? "");

  // The quote must contain the value, or the pointer is to something else.
  if (!containsRun(quote, tokensOf(selection.value))) {
    return { method: "not_located", words: [], page: cited, rejected_pointer: true };
  }

  // Tier 1: the cited span equals the quote.
  if (cited !== null && selection.line !== null && selection.token_start !== null && selection.token_end !== null) {
    const span = wordsInSpan(text, cited, selection.line, selection.token_start, selection.token_end);
    if (span && sameTokens(wordTokens(span), quote)) return located("exact", span, cited);
  }

  // Tier 2: a run of words on one line equals the quote: the cited page first, then every page.
  // On a page the cited line comes first, then the other lines in reading order.
  const pages = [...text.pages].sort((a, b) => a.page - b.page);
  const ordered = cited === null ? pages : [...pages.filter((p) => p.page === cited), ...pages.filter((p) => p.page !== cited)];
  for (const page of ordered) {
    const lines = linesOfPage(page);
    const preferred = page.page === cited && selection.line !== null ? selection.line : null;
    const sequence = [...lines.filter((l) => l.line === preferred), ...lines.filter((l) => l.line !== preferred)];
    for (const line of sequence) {
      const run = findRun(line.words, quote);
      if (run) return located("normalized", run, page.page);
    }
  }

  return { method: "not_located", words: [], page: cited };
}
