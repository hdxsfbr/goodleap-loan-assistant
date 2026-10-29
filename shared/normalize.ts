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

// A bare number ("350") is a money figure only with a money word after it; "monthly payments" is a
// count ("12 monthly payments of $2,500.00"), not a unit, so "monthly" followed by payment(s) is not one.
const MONEY_UNIT = String.raw`dollars?|bucks?|usd\b|(?:per|a|each|every)\s+(?:month|mo)\b|monthly\b(?!\s+(?:payments?|installments?)\b)`;

// Numbers written out in words: "ten years", "three hundred dollars", "a thousand a month".
const NUMBER_WORD = String.raw`(?:seventeen|seventy|sixteen|sixty|nineteen|ninety|eighteen|eighty|fifteen|fifty|fourteen|forty|thirteen|thirty|twelve|twenty|eleven|zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\b`;
const NUMBER_PHRASE = String.raw`(?:(?:a|an)[\s-]+(?=(?:hundred|thousand)\b))?${NUMBER_WORD}(?:[\s-]+(?:and[\s-]+)?${NUMBER_WORD})*`;

const FIGURE_PATTERN = new RegExp(
  String.raw`\$\s?(?<cur>\d[\d,]*(?:\.\d+)?|\.\d+)(?:\s?(?<suffix>thousand|million|mm|k|m)\b)?` +
    String.raw`|(?<![\d.,])(?<pct>\d+(?:\.\d+)?)\s?(?:%|percent\b)` +
    String.raw`|(?<![\d.,])(?<count>\d+)[\s-]*(?<unit>months?|years?)\b` +
    String.raw`|(?<![\d.,$])(?<bare>\d[\d,]*(?:\.\d+)?)(?:\s?(?<bsuffix>thousand|million|k)\b)?[\s-]*(?:${MONEY_UNIT}|\/\s?mo(?:nth)?\b)` +
    String.raw`|(?<![\w-])(?<words>${NUMBER_PHRASE})[\s-]*(?<wunit>percent\b|months?\b|years?\b|${MONEY_UNIT})`,
  "gi",
);

const SPELLED_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

/** "three hundred fifty" -> 350, "a thousand" -> 1000, "twenty-one" -> 21. */
function spelledValue(phrase: string): number {
  let total = 0;
  let current = 0;
  for (const word of phrase.toLowerCase().split(/[\s-]+/)) {
    const small = SPELLED_UNITS[word];
    if (small !== undefined) current += small;
    else if (word === "hundred") current = (current === 0 ? 1 : current) * 100;
    else if (word === "thousand") {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
    }
  }
  return total + current;
}

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
 * A number is also a money figure when a money word follows it, with or without the dollar sign
 * ("350 dollars", "350 bucks", "350 a month", "350 per month", "350/mo", "350 monthly"), and numbers
 * written in words count the same before a unit ("ten years" -> "10 years", "three hundred dollars"
 * -> "300.00", "twelve percent" -> "12%"). A bare number with no unit is not a figure.
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
    } else if (groups.bare !== undefined) {
      tokens.push(canonicalCurrency(groups.bare, groups.bsuffix));
    } else if (groups.words !== undefined && groups.wunit !== undefined) {
      const value = spelledValue(groups.words);
      const unit = groups.wunit.toLowerCase();
      if (unit === "percent") tokens.push(canonicalPercent(String(value)));
      else if (unit === "month" || unit === "months") tokens.push(`${value} months`);
      else if (unit === "year" || unit === "years") tokens.push(`${value} years`);
      else tokens.push(canonicalCurrency(String(value), undefined));
    }
  }
  return tokens;
}

const DECIMAL_TERM_PATTERN = /(?<![\d.,])(?<count>\d+\.\d+)[\s-]*(?<unit>months?|years?)\b/gi;

/**
 * Terms written with a decimal count: "7.5 years", "8.33 years", "0.25 years", in the same
 * canonical spelling `figureTokens` gives whole terms ("7.5 years", trailing zeros dropped). Kept
 * apart from `figureTokens`, whose whole-number behavior other code depends on; the number-match
 * check reads both so a fractional term in prose is gated like any other figure.
 */
export function decimalTermTokens(s: string): string[] {
  const tokens: string[] = [];
  for (const match of s.matchAll(DECIMAL_TERM_PATTERN)) {
    const { count, unit } = match.groups ?? {};
    if (count === undefined || unit === undefined) continue;
    tokens.push(`${Number(count)} ${unit.toLowerCase().startsWith("month") ? "months" : "years"}`);
  }
  return tokens;
}

/**
 * The canonical spelling of one formatted figure such as "$396.29", "9.99%", "120 months" or
 * "7.5 years"; null when the text holds no figure. Used to normalize the allowed-value lists.
 */
export function normalizeFigure(s: string): string | null {
  return figureTokens(s)[0] ?? decimalTermTokens(s)[0] ?? null;
}
