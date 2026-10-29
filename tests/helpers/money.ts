/** "$30,000.00" -> 3000000, for expected figures written the way the design's tables write them. */
export function usdToCents(text: string): number {
  const match = /^\$(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(text);
  if (!match) throw new Error(`not a dollar amount: ${text}`);
  return Number((match[1] ?? "").replace(/,/g, "")) * 100 + Number(match[2]);
}
