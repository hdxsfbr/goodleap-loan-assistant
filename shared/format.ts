// The only money and APR formatters. Money is integer cents, APR is integer basis points.
// Every number a person reads comes through formatMoney or formatApr.

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 3000000 -> "$30,000.00". Always two decimals and a thousands separator. */
export function formatMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`formatMoney expects integer cents, got ${cents}`);
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${groupThousands(String(dollars))}.${remainder}`;
}

/** 999 -> "9.99%". Always two decimals. */
export function formatApr(bps: number): string {
  if (!Number.isSafeInteger(bps)) {
    throw new RangeError(`formatApr expects integer basis points, got ${bps}`);
  }
  const negative = bps < 0;
  const abs = Math.abs(bps);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}

const MONEY_PATTERN = /^(\d+)(?:\.(\d+))?\s*(k|m|mm|thousand|million)?$/i;

const SUFFIX_MULTIPLIER: Record<string, bigint> = {
  k: 1000n,
  thousand: 1000n,
  m: 1000000n,
  mm: 1000000n,
  million: 1000000n,
};

/**
 * The inverse of formatMoney for human input: "$30K", "30,000", "30000.00", "$1.5m" -> cents.
 * Returns null when the text is not a positive amount that lands on a whole number of cents.
 */
export function parseMoney(text: string): number | null {
  const cleaned = text.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  const match = MONEY_PATTERN.exec(cleaned);
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  const multiplier = match[3] ? (SUFFIX_MULTIPLIER[match[3].toLowerCase()] ?? 1n) : 1n;
  const numerator = BigInt(whole + fraction) * multiplier * 100n;
  const denominator = 10n ** BigInt(fraction.length);
  if (numerator % denominator !== 0n) return null;
  const cents = numerator / denominator;
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}
