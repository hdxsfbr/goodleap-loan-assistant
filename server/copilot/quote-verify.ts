// Provenance primitive for chat-sourced proposals: a quote is accepted only when it appears,
// word for word after normalization, in the contractor message it cites, and only when what it
// says supports the value proposed with it. The normalization is shared/normalize.ts's; this
// file defines no rule of its own.

import type { ApplicationFieldDef } from "@shared/application-schema";
import { PRODUCT_IDS } from "@shared/catalog-ids";
import { parseMoney } from "@shared/format";
import { figureTokens, normalizeText } from "@shared/normalize";

export interface QuoteCheck {
  ok: boolean;
  /** The quote after `normalizeText`; empty when the quote has no words. */
  normalized_quote: string;
}

/** True when `run` is a run of whole tokens of `haystack` (both already normalized). */
function hasRun(haystack: string, run: string): boolean {
  return run !== "" && ` ${haystack} `.includes(` ${run} `);
}

/**
 * True when the normalized quote is a run of whole tokens of the normalized message. Matching on
 * token boundaries keeps "ten" from being found inside "often". A paraphrase, a quote from another
 * message or an empty quote is not ok.
 */
export function verifyQuote(quote: string, messageText: string): QuoteCheck {
  const normalized_quote = normalizeText(quote);
  if (normalized_quote === "") return { ok: false, normalized_quote };
  return { ok: hasRun(normalizeText(messageText), normalized_quote), normalized_quote };
}

/** Every amount a quote states, in cents: "$30K", "30,000", "$30,000.00", "30 thousand", "thirty thousand dollars". */
function amountsIn(quote: string, normalized: string): Set<number> {
  const amounts = new Set<number>();
  const tokens = normalized.split(" ");
  tokens.forEach((token, index) => {
    for (const candidate of [token, `${token} ${tokens[index + 1] ?? ""}`]) {
      const cents = parseMoney(candidate);
      if (cents !== null) amounts.add(cents);
    }
  });
  for (const figure of figureTokens(quote)) {
    const cents = /^\d+\.\d+$/.test(figure) ? parseMoney(figure) : null;
    if (cents !== null) amounts.add(cents);
  }
  return amounts;
}

/** The months a term figure stands for: "120 months" and "10 years" are both 120; null for a non-term figure. */
function termMonths(figure: string): number | null {
  const match = /^(\d+) (months|years)$/.exec(figure);
  if (!match) return null;
  return Number(match[1]) * (match[2] === "years" ? 12 : 1);
}

/** Whether a word of an enum option ("roofing", "kitchen", "fixed", "10y", "18m") is stated in the quote. */
function optionWordStated(word: string, quote: string, tokens: readonly string[]): boolean {
  const figures = figureTokens(quote);
  const years = /^(\d+)y$/.exec(word);
  if (years) return figures.some((figure) => termMonths(figure) === Number(years[1]) * 12);
  const months = /^(\d+)m$/.exec(word);
  if (months) return figures.includes(`${months[1]} months`);
  if (word === "zero" && figures.includes("0%")) return true;
  // A stem, so "roof" states roofing, "window" states windows and "bath" states bathroom.
  const stem = word.length > 4 ? word.replace(/(?:ing|s)$/, "") : word;
  return tokens.some((token) => token.startsWith(stem));
}

function enumSupported(fieldId: string, option: string, stated: string, quote: string, normalized: string): boolean {
  if (hasRun(normalized, normalizeText(stated)) || hasRun(normalized, normalizeText(option.replace(/_/g, " ")))) {
    return true;
  }
  if (fieldId === "preferred_term_months") {
    return figureTokens(quote).some((figure) => termMonths(figure) === Number(option));
  }
  if (fieldId === "selected_product_id") {
    const letter = "abc"[PRODUCT_IDS.indexOf(option as (typeof PRODUCT_IDS)[number])];
    if (letter !== undefined && hasRun(normalized, `option ${letter}`)) return true;
  }
  const tokens = normalized.split(" ");
  return option.split("_").some((word) => optionWordStated(word, quote, tokens));
}

/**
 * Whether what a verified quote says supports the value proposed with it, so a real quote cannot
 * carry a different value ("$30K" for $40K). `stated` is the value as the model wrote it and
 * `stored` the value the field would hold. Money: the quote states that amount. Text and ZIP: the
 * normalized quote contains the normalized value. Enum: the quote states the option, in the model's
 * words, in the option's own words, or by what the option means (a term as "10-year" for 120
 * months; a product as "Option A", "10-year" or "deferred").
 */
export function quoteSupportsValue(
  field: Pick<ApplicationFieldDef, "id" | "type">,
  stated: string,
  stored: string | number,
  quote: string,
): boolean {
  const normalized = normalizeText(quote);
  switch (field.type) {
    case "money":
      return typeof stored === "number" && amountsIn(quote, normalized).has(stored);
    case "enum":
      return enumSupported(field.id, String(stored), stated, quote, normalized);
    default:
      return hasRun(normalized, normalizeText(stated));
  }
}
