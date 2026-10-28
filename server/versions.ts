import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VersionsBlock } from "@shared/schemas";
import { PINNED_MODELS, effectiveModelId } from "./config.js";

// The versions block: the content hash of each file that defines behavior, computed at boot.
// There are no hand-maintained version constants to go stale. A file that a later build step has
// not written yet is recorded as `<name>@absent`, so the server boots at every step.

export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

type HashedKey = Exclude<
  keyof VersionsBlock,
  "git_sha" | "copilot_model" | "extraction_model" | "judge_model"
>;

/** The files behind each hashed key, relative to the project root. `schemas` is the three document schemas in slot order. */
export const VERSION_FILES: Record<HashedKey, readonly string[]> = {
  copilot_prompt: ["server/prompts/copilot.system.md"],
  judge_prompt: ["server/prompts/judge.system.md"],
  extraction_prompt: ["server/prompts/extraction.system.md"],
  denylist: ["server/guardrail/denylist.json"],
  template: ["server/domain/disclosures/template.ts"],
  catalog: ["server/domain/catalog.ts"],
  calculator: ["server/domain/payments/calculator.ts"],
  application_schema: ["shared/application-schema.ts"],
  schemas: [
    "shared/document-schemas/pay_stub.ts",
    "shared/document-schemas/estimate.ts",
    "shared/document-schemas/scope_letter.ts",
  ],
  fallback_texts: ["server/guardrail/fallback.ts"],
};

function hashFiles(root: string, name: string, files: readonly string[]): string {
  const paths = files.map((file) => `${root}${file}`);
  if (!paths.every((path) => existsSync(path))) return `${name}@absent`;
  const hash = createHash("sha256");
  for (const path of paths) hash.update(readFileSync(path));
  return `${name}@${hash.digest("hex").slice(0, 8)}`;
}

function gitSha(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/** Computes the block from the files under `root` (the project root by default). */
export function computeVersions(root: string = PROJECT_ROOT): VersionsBlock {
  const base = root.endsWith("/") ? root : `${root}/`;
  const hashed = Object.fromEntries(
    (Object.keys(VERSION_FILES) as HashedKey[]).map((key) => [
      key,
      hashFiles(base, key, VERSION_FILES[key]),
    ]),
  ) as Record<HashedKey, string>;
  return {
    ...hashed,
    git_sha: gitSha(base),
    copilot_model: effectiveModelId(PINNED_MODELS.copilot),
    extraction_model: effectiveModelId(PINNED_MODELS.extraction),
    judge_model: effectiveModelId(PINNED_MODELS.judge),
  };
}

let cached: VersionsBlock | undefined;

/**
 * The block for this process, computed on first use and then fixed ("computed at boot"). It is
 * not computed at import time because the model ids depend on .env, which server/index.ts loads
 * after its imports are evaluated.
 */
export function getVersions(): VersionsBlock {
  cached ??= computeVersions();
  return { ...cached };
}

/** Test hook: forget the cached block. */
export function resetVersionsCache(): void {
  cached = undefined;
}

/** The block as a read-only object, resolved on first access. Equivalent to `getVersions()`. */
export const VERSIONS: Readonly<VersionsBlock> = new Proxy({} as VersionsBlock, {
  get: (_target, key) => getVersions()[key as keyof VersionsBlock],
  has: (_target, key) => key in getVersions(),
  ownKeys: () => Reflect.ownKeys(getVersions()),
  getOwnPropertyDescriptor: (_target, key) => {
    const block = getVersions();
    return key in block
      ? { value: block[key as keyof VersionsBlock], enumerable: true, configurable: true }
      : undefined;
  },
  set: () => false,
});
