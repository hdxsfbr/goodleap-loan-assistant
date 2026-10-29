// The number-match check: every currency, percent and term figure in model prose must be a figure
// the model was handed. Deterministic, no model call.

import { decimalTermTokens, figureTokens, normalizeFigure } from "@shared/normalize";
import type { GuardrailAllowed, Verdict } from "@shared/schemas";

/**
 * Every figure in a text in one canonical spelling: currency, percent and "N months/years" terms,
 * including terms with a decimal count ("7.5 years"). The turn uses this for the contractor's
 * figures and the check uses it for the prose, so both sides are spelled alike.
 */
export function allFigureTokens(text: string): string[] {
  return [...figureTokens(text), ...decimalTermTokens(text)];
}

/** One allowed entry in canonical spelling: a formatted figure ("$396.29") or an already-canonical one ("396.29"). */
function canonical(entry: string): string {
  return normalizeFigure(entry) ?? entry.trim().toLowerCase();
}

/** A canonical token as a reader would write it: a bare number is a currency figure. */
const display = (token: string): string => (/^\d+\.\d{2}$/.test(token) ? `$${token}` : token);

/** A canonical currency token ("414.14"), as opposed to a percent ("9.99%") or a term ("120 months"). */
const isMoney = (token: string): boolean => /^\d+\.\d+$/.test(token);

/** "Option A", "option b": the label a sentence names. */
const OPTION_LABEL = /\boption\s+([abc])\b/gi;

/** Sentences and clauses: split after ". ", "! " and "? ", and at semicolons and line breaks. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|[;\n]+/).filter((sentence) => sentence.trim() !== "");
}

/** The one option a sentence names ("Option B"), or null when it names none or several. */
function soleOption(sentence: string): string | null {
  const letters = new Set([...sentence.matchAll(OPTION_LABEL)].map((match) => (match[1] ?? "").toUpperCase()));
  const [only] = letters;
  return letters.size === 1 && only !== undefined ? `Option ${only}` : null;
}

/**
 * Blocks any figure in `text` that equals no allowed calculator value for this turn and no figure
 * the contractor typed in the window. With no calculation in the turn the calculator list is empty,
 * so the contractor's figures are the whole allowed set and an invented payment still blocks.
 *
 * When the calculation's per-option values are given, a sentence that names exactly one option
 * ("Option A") may carry only that option's own money figures (or the contractor's): option B's
 * payment attached to option A blocks even though it is a calculator value. A sentence that names
 * no option or several keeps the whole-calculation rule.
 *
 * Returns the offending tokens, each once, in order of appearance.
 */
export function checkNumberMatch(text: string, allowed: GuardrailAllowed): Verdict {
  const contractor = new Set(allowed.contractor_figures.map(canonical));
  const permitted = new Set([...allowed.calculator_values.map(canonical), ...contractor]);
  const perOption = new Map(
    Object.entries(allowed.option_values ?? {}).map(([label, values]) => [label, new Set(values.map(canonical))]),
  );

  const order: string[] = [];
  const unmatched = new Set<string>();
  const misattached = new Map<string, string>();
  for (const sentence of sentencesOf(text)) {
    const label = perOption.size > 0 ? soleOption(sentence) : null;
    const own = label === null ? null : (perOption.get(label) ?? new Set<string>());
    for (const token of allFigureTokens(sentence)) {
      if (!permitted.has(token)) unmatched.add(token);
      else if (label !== null && own !== null && isMoney(token) && !own.has(token) && !contractor.has(token)) {
        misattached.set(token, label);
      } else continue;
      if (!order.includes(token)) order.push(token);
    }
  }

  const matched = order.map(display);
  if (matched.length === 0) return { pass: true, layer: "number_match", outcome: "pass" };

  const none = allowed.calculator_values.length === 0;
  const reasons: string[] = [];
  if (unmatched.size > 0) {
    reasons.push(
      `The reply contains figures that are not from ${none ? "the contractor's message" : "the payment calculation or the contractor's message"}: ` +
        `${[...unmatched].map(display).join(", ")}. Write only figures copied exactly from the calculation result or typed by the contractor, or describe the point without figures.`,
    );
  }
  if (misattached.size > 0) {
    reasons.push(
      `The reply attaches a figure to an option it does not belong to: ` +
        `${[...misattached].map(([token, label]) => `${display(token)} is not one of ${label}'s figures`).join("; ")}. ` +
        "Give each option only its own figures from the calculation result.",
    );
  }
  return {
    pass: false,
    layer: "number_match",
    outcome: "blocked",
    reason: reasons.join(" "),
    matched,
  };
}
