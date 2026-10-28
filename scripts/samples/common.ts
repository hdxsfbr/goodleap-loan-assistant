// Shared helpers for the one-time sample tooling (generate.ts, ocr-paystub.ts, verify.ts).
import { readFileSync } from "node:fs";
import path from "node:path";

export const SCRIPT_DIR = import.meta.dirname;
export const DEFAULT_SAMPLES_DIR = path.resolve(SCRIPT_DIR, "..", "..", "samples");
// Scratch folder for the intermediate PNG and the tesseract language-data cache. Git-ignored.
export const WORK_DIR = path.join(SCRIPT_DIR, ".work");
export const DEFAULT_PNG = path.join(WORK_DIR, "paystub.png");

export type Slot = "pay_stub" | "estimate" | "scope_letter";

export interface TruthField {
  /** The value exactly as it is written on the page (for derived fields: as it would be formatted). */
  value: string;
  /** Integer cents, for money fields. */
  cents?: number;
  /** ISO date, for date fields. */
  iso?: string;
  /** Normalized enum value, for enum fields. */
  normalized?: string;
  /** Integer value, for integer fields. */
  integer?: number;
  /** True for a field computed from other fields rather than read from the page. */
  derived?: boolean;
}

export type GroundTruth = Record<Slot, Record<string, TruthField>>;

export function loadGroundTruth(samplesDir: string): GroundTruth {
  const file = path.join(samplesDir, "ground_truth.json");
  return JSON.parse(readFileSync(file, "utf8")) as GroundTruth;
}

export function field(truth: GroundTruth, slot: Slot, id: string): TruthField {
  const f = truth[slot][id];
  if (!f) throw new Error(`ground_truth.json has no ${slot}.${id}`);
  return f;
}

/** "$31,000.00" or "2,350.00" to integer cents. */
export function parseMoneyCents(text: string): number {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error(`not a money string: ${text}`);
  return Math.round(Number(cleaned) * 100);
}

/** Tiny `--flag value` / `--flag` parser; unknown flags are an error. */
export function parseFlags(
  argv: string[],
  spec: Record<string, { value: boolean; description: string }>,
): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const name = arg.replace(/^--/, "");
    const def = spec[name];
    if (!arg.startsWith("--") || !def) {
      const known = Object.entries(spec)
        .map(([k, v]) => `--${k}${v.value ? " <value>" : ""}  ${v.description}`)
        .join("\n  ");
      throw new Error(`unknown argument: ${arg}\nusage:\n  ${known}`);
    }
    if (def.value) {
      const next = argv[++i];
      if (next === undefined) throw new Error(`--${name} needs a value`);
      out[name] = next;
    } else {
      out[name] = true;
    }
  }
  return out;
}
