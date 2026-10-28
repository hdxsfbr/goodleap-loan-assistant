// The only text normalizer. The copilot quote check, the number-match guardrail and the extraction
// matcher all compare strings through these functions; nothing else defines a normalization rule.

const NUMBER_WRAPPERS = /[$,%()]/g;
const NUMERIC_SHAPE = /^[-+]?[0-9ol][0-9ol./-]*$/;
const BOUNDARY_PUNCTUATION = /^[;:,.!?()"']+|[;:,.!?()"']+$/g;

/**
 * Sentence punctuation around a token is not part of the number: "$42.50;" is "$42.50" and
 * "1,812.40." is "1,812.40". Separators inside the token stay, so "$42.50" never becomes "$4250".
 */
function stripBoundaryPunctuation(s: string): string {
  return s.replace(BOUNDARY_PUNCTUATION, "");
}

/**
 * True when a raw token reads as a number or a date once boundary punctuation, currency marks and
 * OCR look-alikes are ignored: "$4,250.00", "03/15/2025", "l,000", "O1/15/2025", "$42.50;". A
 * token needs at least one real digit, so words such as "lol" are not numeric.
 */
export function isNumericToken(s: string): boolean {
  const t = stripBoundaryPunctuation(s).toLowerCase().replace(NUMBER_WRAPPERS, "");
  return NUMERIC_SHAPE.test(t) && /[0-9]/.test(t);
}

/**
 * Lowercase; drop "$" and ","; strip punctuation except "." "/" "-" inside numbers and dates;
 * fold "O" to "0" and "l" to "1" inside numeric tokens.
 */
export function normalizeToken(s: string): string {
  const core = stripBoundaryPunctuation(s);
  if (isNumericToken(core)) {
    return core
      .toLowerCase()
      .replace(NUMBER_WRAPPERS, "")
      .replace(/o/g, "0")
      .replace(/l/g, "1")
      .replace(/[^0-9./-]/g, "")
      .replace(/^[./]+/, "")
      .replace(/[./-]+$/, "");
  }
  return s.toLowerCase().replace(/[$,]/g, "").replace(/[\p{P}\p{S}]/gu, "");
}

/**
 * Tokenize on whitespace, normalize each token, join hyphenated line breaks and collapse
 * whitespace.
 */
export function normalizeText(s: string): string {
  const joined = s.replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu, "$1$2");
  return joined
    .split(/\s+/)
    .map(normalizeToken)
    .filter((token) => token.length > 0)
    .join(" ");
}

const FIGURE_PATTERN = new RegExp(
  String.raw`\$\s?(?<cur>\d[\d,]*(?:\.\d+)?|\.\d+)(?:\s?(?<suffix>thousand|million|mm|k|m)\b)?` +
    String.raw`|(?<![\d.,])(?<pct>\d+(?:\.\d+)?)\s?(?:%|percent\b)` +
    String.raw`|(?<![\d.,])(?<count>\d+)[\s-]*(?<unit>months?|years?)\b`,
  "gi",
);

const SUFFIX_MULTIPLIER: Record<string, bigint> = {
  k: 1000n,
  thousand: 1000n,
  m: 1000000n,
  mm: 1000000n,
  million: 1000000n,
};

function canonicalCurrency(raw: string, suffix: string | undefined): string {
  const cleaned = raw.replace(/,/g, "");
  const [wholePart = "", fraction = ""] = cleaned.split(".");
  const whole = wholePart === "" ? "0" : wholePart;
  const multiplier = suffix ? (SUFFIX_MULTIPLIER[suffix.toLowerCase()] ?? 1n) : 1n;
  const numerator = BigInt(whole + fraction) * multiplier * 100n;
  const denominator = 10n ** BigInt(fraction.length);
  if (numerator % denominator !== 0n) return `${whole}.${fraction}`;
  const cents = numerator / denominator;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function canonicalPercent(raw: string): string {
  const trimmed = raw.includes(".") ? raw.replace(/0+$/, "").replace(/\.$/, "") : raw;
  return `${trimmed.replace(/^0+(?=\d)/, "")}%`;
}

/**
 * Every currency, percent, and integer-followed-by-month(s)/year(s) token in a string, in order
 * of appearance, in one canonical spelling so that equal figures compare equal:
 *   "$40K" and "$40,000" -> "40000.00"; "$414.1" -> "414.10"; "0.00%" and "0 percent" -> "0%";
 *   "120 months" and "120-month" -> "120 months"; "1 year" -> "1 years".
 */
export function figureTokens(s: string): string[] {
  const tokens: string[] = [];
  for (const match of s.matchAll(FIGURE_PATTERN)) {
    const groups = match.groups ?? {};
    if (groups.cur !== undefined) {
      tokens.push(canonicalCurrency(groups.cur, groups.suffix));
    } else if (groups.pct !== undefined) {
      tokens.push(canonicalPercent(groups.pct));
    } else if (groups.count !== undefined && groups.unit !== undefined) {
      const unit = groups.unit.toLowerCase().startsWith("month") ? "months" : "years";
      tokens.push(`${Number(groups.count)} ${unit}`);
    }
  }
  return tokens;
}

/**
 * The canonical spelling of one formatted figure such as "$396.29", "9.99%" or "120 months";
 * null when the text holds no figure. Used to normalize the allowed-value lists.
 */
export function normalizeFigure(s: string): string | null {
  return figureTokens(s)[0] ?? null;
}
