// Server configuration. Everything is read from the environment on access, not at import time,
// because server/index.ts loads .env after its static imports have been evaluated.

const DEFAULT_PORT = 3000;

function flag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !["false", "0", "no", "off"].includes(raw);
}

function port(): number {
  const parsed = Number(process.env.PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

function baseUrl(): string | undefined {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim();
  return raw ? raw : undefined;
}

export const config = {
  get port(): number {
    return port();
  },
  /** Whether a key is present. The key itself is read only by the LLM client, never logged. */
  get hasLlmKey(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  },
  /** Optional API base URL, for example an OpenRouter endpoint. Undefined when blank. */
  get llmBaseUrl(): string | undefined {
    return baseUrl();
  },
  get copilotEnabled(): boolean {
    return flag("COPILOT_ENABLED");
  },
  get extractionEnabled(): boolean {
    return flag("EXTRACTION_ENABLED");
  },
};

export type Effort = "low" | "medium" | "high";

export interface UseCaseConfig {
  /** The model id in effect: the pinned id, translated when the base URL is OpenRouter. */
  model: string;
  effort: Effort;
  max_tokens: number;
  /** Per-call SDK options. */
  sdk: { timeout: number; maxRetries: number };
}

/** The pinned Anthropic model ids. */
export const PINNED_MODELS = {
  copilot: "claude-sonnet-5-5",
  extraction: "claude-opus-5-5",
  judge: "claude-haiku-5-5",
} as const;

/**
 * Against an OpenRouter base URL the same models are named `anthropic/claude-<family>-5.5`:
 * prefix the vendor and turn the hyphen before the version into a dot. Any other base URL, or
 * none, keeps the pinned id.
 */
export function translateModelId(pinned: string, url: string | undefined): string {
  if (!url?.includes("openrouter.ai")) return pinned;
  return `anthropic/${pinned.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}

/** The pinned id translated for the base URL in the environment. */
export function effectiveModelId(pinned: string): string {
  return translateModelId(pinned, baseUrl());
}

/** Per use case: the effective model id, effort, `max_tokens` and SDK options. */
export function useCases(): { copilot: UseCaseConfig; extraction: UseCaseConfig; judge: UseCaseConfig } {
  return {
    copilot: {
      model: effectiveModelId(PINNED_MODELS.copilot),
      effort: "low",
      max_tokens: 4096,
      sdk: { timeout: 15_000, maxRetries: 0 },
    },
    extraction: {
      model: effectiveModelId(PINNED_MODELS.extraction),
      effort: "medium",
      max_tokens: 4096,
      sdk: { timeout: 60_000, maxRetries: 1 },
    },
    judge: {
      model: effectiveModelId(PINNED_MODELS.judge),
      effort: "low",
      max_tokens: 1024,
      sdk: { timeout: 15_000, maxRetries: 0 },
    },
  };
}

/** The copilot loop's cap on model rounds in one turn. */
export const COPILOT_ROUND_CAP = 3;
