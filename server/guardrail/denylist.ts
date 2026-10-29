// The deny-list check: the floor under the judge. Entries live in denylist.json (versioned by its
// content hash as `denylist@<sha>`, owned by Compliance); this file compiles them and runs them.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Verdict } from "@shared/schemas";
import { OUT_OF_SCOPE_REPLY } from "./fallback.js";

export const DenylistEntrySchema = z
  .object({
    /** A regular expression source, matched case-insensitively. */
    pattern: z.string().min(1),
    reason: z.string().min(1),
    added_by: z.string().min(1),
    date: z.string().min(1),
    /** Phrases inside which a match is not a violation. `{{OUT_OF_SCOPE_REPLY}}` names the fixed reply. */
    allowed_contexts: z.array(z.string().min(1)),
  })
  .strict();
export type DenylistEntry = z.infer<typeof DenylistEntrySchema>;

const DenylistFileSchema = z.object({ entries: z.array(DenylistEntrySchema).min(1) }).passthrough();

/** Placeholders an allowed context may use, resolved from the Compliance-owned fixed texts. */
const CONTEXT_PLACEHOLDERS: Readonly<Record<string, string>> = {
  "{{OUT_OF_SCOPE_REPLY}}": OUT_OF_SCOPE_REPLY,
};

export function loadDenylist(path: URL = new URL("./denylist.json", import.meta.url)): DenylistEntry[] {
  return DenylistFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).entries;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Typographic apostrophes and quotes read as the plain ones, so the fixed reply matches however it was typeset. */
const foldQuotes = (s: string): string =>
  s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');

function contextRegex(phrase: string): RegExp {
  const resolved = CONTEXT_PLACEHOLDERS[phrase] ?? phrase;
  const source = foldQuotes(resolved).trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(source, "gi");
}

interface Compiled {
  entry: DenylistEntry;
  pattern: RegExp;
  contexts: RegExp[];
}

function compile(entries: readonly DenylistEntry[]): Compiled[] {
  // Longest pattern first, so "pre-approved" is matched whole before "approved" can match inside it.
  return [...entries]
    .sort((a, b) => b.pattern.length - a.pattern.length)
    .map((entry) => ({
      entry,
      pattern: new RegExp(entry.pattern, "gi"),
      contexts: entry.allowed_contexts.map(contextRegex),
    }));
}

let defaultCompiled: Compiled[] | undefined;

/**
 * Checks prose against the deny-list. A match inside one of its entry's allowed contexts is
 * skipped; anything else blocks. Returns the matched terms in order of first appearance.
 */
export function checkDenylist(text: string, entries?: readonly DenylistEntry[]): Verdict {
  const compiled = entries ? compile(entries) : (defaultCompiled ??= compile(loadDenylist()));
  const found: { index: number; term: string; reason: string }[] = [];
  // Matched spans are blanked as they are found, so a shorter pattern cannot match inside a longer one.
  let working = foldQuotes(text);
  for (const { entry, pattern, contexts } of compiled) {
    let masked = working;
    for (const context of contexts) masked = masked.replace(context, (m) => " ".repeat(m.length));
    pattern.lastIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      found.push({ index: match.index ?? 0, term: match[0].toLowerCase(), reason: entry.reason });
      working =
        working.slice(0, match.index) + " ".repeat(match[0].length) + working.slice((match.index ?? 0) + match[0].length);
    }
  }
  if (found.length === 0) return { pass: true, layer: "denylist", outcome: "pass" };
  found.sort((a, b) => a.index - b.index);
  const matched = [...new Set(found.map((f) => f.term))];
  const reasons = [...new Set(found.map((f) => f.reason))];
  return {
    pass: false,
    layer: "denylist",
    outcome: "blocked",
    reason: `The reply uses verdict wording (${matched.map((m) => `"${m}"`).join(", ")}). ${reasons.join(" ")}`,
    matched,
  };
}
