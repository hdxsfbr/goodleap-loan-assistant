// The single @anthropic-ai/sdk import site of the server (errors.ts imports only the error classes).
// Three named call sites, one per use case, each with its pinned model, effort, token cap and SDK
// options from server/config.ts. Every call appends a `model.call` audit event holding the full
// request body and the raw response, and maps SDK errors and refusals to the error taxonomy.
// The SDK reads ANTHROPIC_API_KEY from the environment itself; the key is never read, logged or
// stored here. The base URL comes from ANTHROPIC_BASE_URL through server/config.ts (see sdkBaseUrl).

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import type { ErrorCode, JsonValue } from "@shared/schemas";
import { audit, type Ctx } from "../audit-log.js";
import { config, useCases, type UseCaseConfig } from "../config.js";
import { AppError, mapSdkError } from "../errors.js";
import { getVersions } from "../versions.js";

export type UseCase = "copilot" | "extraction" | "judge";

/** What every call reports back besides the response: the audit event and the measurements. */
export interface CallRecord {
  /** The `model.call` event this call appended. */
  event_id: string;
  model_id: string;
  latency_ms: number;
  usage: { input: number; output: number; cache_read: number };
  stop_reason: string | null;
}

/** An `AppError` raised by a model call that already appended its `model.call` event. */
export class ModelCallError extends AppError {
  readonly event_id: string;

  constructor(error: AppError, event_id: string) {
    super(error.code, error.message, { retryable: error.retryable, cause: error });
    this.name = "ModelCallError";
    this.event_id = event_id;
  }
}

let client: Anthropic | undefined;

/**
 * The base URL to hand the SDK. The SDK appends `/v1/messages` to its base URL itself, while
 * OpenRouter publishes its Anthropic-compatible endpoint as `https://openrouter.ai/api/v1`; given
 * that value as is, the SDK would call `.../api/v1/v1/messages` and get a 404. A trailing `/v1` is
 * therefore dropped, so either spelling of the variable works. Undefined leaves the SDK's default.
 */
export function sdkBaseUrl(configured: string | undefined): string | undefined {
  if (!configured) return undefined;
  return configured.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** A new SDK client: `maxRetries: 0`, the key from the environment, the base URL as `sdkBaseUrl` gives it. */
export function newSdkClient(): Anthropic {
  const baseURL = sdkBaseUrl(config.llmBaseUrl);
  return new Anthropic({ maxRetries: 0, ...(baseURL ? { baseURL } : {}) });
}

/** The one SDK client, built on first use. */
function getClient(): Anthropic {
  if (client) return client;
  if (!config.hasLlmKey) throw new AppError("llm.missing_key");
  client = newSdkClient();
  return client;
}

/** Test hook: use `fake` instead of a real client, or pass undefined to build a real one again. */
export function setClientForTests(fake: unknown): void {
  client = fake as Anthropic | undefined;
}

/** Anything JSON can carry, with `undefined`, functions and non-finite numbers removed, as the audit schema requires. */
function jsonClean(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** The audit-safe part of a thrown value: never headers, never the key. */
function errorSummary(err: unknown): JsonValue {
  if (typeof err !== "object" || err === null) return { message: String(err) };
  const e = err as { name?: unknown; status?: unknown; message?: unknown };
  return jsonClean({
    name: typeof e.name === "string" ? e.name : "Error",
    status: typeof e.status === "number" ? e.status : null,
    message: typeof e.message === "string" ? e.message : String(err),
  });
}

/** A parsed response without the SDK's derived `parsed_output` copies, so the audit keeps one copy of the text. */
function withoutParsedCopies(message: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  delete copy.parsed_output;
  if (Array.isArray(copy.content)) {
    for (const block of copy.content as Record<string, unknown>[]) delete block.parsed_output;
  }
  return copy;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

interface LoggedCall {
  ctx: Ctx;
  use_case: UseCase;
  cfg: UseCaseConfig;
  params: CreateParams;
  message_ids: string[];
  prompt_version: string;
  system_text: string;
  run: (c: Anthropic, params: CreateParams, options: { timeout: number; maxRetries: number }) => Promise<unknown>;
}

async function loggedCall(call: LoggedCall): Promise<{ message: Anthropic.Message; record: CallRecord }> {
  const { ctx, use_case, cfg, params } = call;
  const modelCtx: Ctx = { ...ctx, actor: { type: "model", id: cfg.model } };
  const raw_input = jsonClean(params);
  const context = {
    message_ids: call.message_ids,
    system_prompt_version: call.prompt_version,
    system_prompt_sha256: sha256(call.system_text),
  };
  const started = performance.now();
  const elapsed = (): number => Math.round((performance.now() - started) * 1000) / 1000;

  let response: Anthropic.Message;
  try {
    response = (await call.run(getClient(), params, cfg.sdk)) as Anthropic.Message;
  } catch (err) {
    const mapped = mapSdkError(err);
    const event = audit.emit(modelCtx, "model.call", {
      use_case,
      model_id: cfg.model,
      effort: cfg.effort,
      context,
      raw_input,
      raw_output: { error: errorSummary(err) },
      usage: { input: 0, output: 0, cache_read: 0 },
      latency_ms: elapsed(),
      stop_reason: null,
      error_code: mapped.code,
    });
    throw new ModelCallError(mapped, event.event_id);
  }

  const latency_ms = elapsed();
  const usage = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
    cache_read: response.usage?.cache_read_input_tokens ?? 0,
  };
  const stop_reason = response.stop_reason ?? null;
  const refused = stop_reason === "refusal";
  const error_code: ErrorCode | undefined = refused ? "llm.refusal" : undefined;
  const event = audit.emit(modelCtx, "model.call", {
    use_case,
    model_id: cfg.model,
    effort: cfg.effort,
    context,
    raw_input,
    raw_output: jsonClean(withoutParsedCopies(response)),
    usage,
    latency_ms,
    stop_reason,
    ...(error_code === undefined ? {} : { error_code }),
  });
  if (refused) throw new ModelCallError(new AppError("llm.refusal"), event.event_id);
  return {
    message: response,
    record: { event_id: event.event_id, model_id: cfg.model, latency_ms, usage, stop_reason },
  };
}

// ---------------------------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------------------------

export interface CopilotCallInput {
  /** The stable block (with its cache breakpoint) first, the volatile block after it. */
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  /** Transcript message ids the request carries, for the audit context. */
  message_ids: string[];
}

export type CopilotCallResult = CallRecord & { message: Anthropic.Message };

/**
 * One copilot round: `messages.create` on the copilot model with `tool_choice: auto`, the tools
 * (each `strict: true`), `output_config.effort` and no `thinking` parameter. `stop_reason:
 * "max_tokens"` is returned to the caller; a refusal throws `llm.refusal`.
 */
export async function copilotCall(ctx: Ctx, input: CopilotCallInput): Promise<CopilotCallResult> {
  const cfg = useCases().copilot;
  const params: CreateParams = {
    model: cfg.model,
    max_tokens: cfg.max_tokens,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    tool_choice: { type: "auto" },
    output_config: { effort: cfg.effort },
  };
  const { message, record } = await loggedCall({
    ctx,
    use_case: "copilot",
    cfg,
    params,
    message_ids: input.message_ids,
    prompt_version: getVersions().copilot_prompt,
    system_text: input.system.map((block) => block.text).join("\n\n"),
    run: (c, p, options) => c.messages.create(p, options),
  });
  return { ...record, message };
}

// ---------------------------------------------------------------------------------------------
// Structured output: the judge and extraction
// ---------------------------------------------------------------------------------------------

export interface ParsedCallInput<S extends z.ZodType> {
  system: string;
  /** The user message. */
  prompt: string;
  /** A zod v4 schema; the SDK turns it into the JSON schema of `output_config.format` and parses the reply with it. */
  outputSchema: S;
  message_ids?: string[];
}

export type ParsedCallResult<S extends z.ZodType> = CallRecord & {
  message: Anthropic.Message;
  /** The reply parsed with `outputSchema`; null when the model returned no parseable text. */
  parsed: z.infer<S> | null;
};

async function parsedCall<S extends z.ZodType>(
  ctx: Ctx,
  use_case: "judge" | "extraction",
  input: ParsedCallInput<S>,
): Promise<ParsedCallResult<S>> {
  const cfg = useCases()[use_case];
  const params: CreateParams = {
    model: cfg.model,
    max_tokens: cfg.max_tokens,
    system: input.system,
    messages: [{ role: "user", content: input.prompt }],
    output_config: { effort: cfg.effort, format: zodOutputFormat(input.outputSchema) },
  };
  const { message, record } = await loggedCall({
    ctx,
    use_case,
    cfg,
    params,
    message_ids: input.message_ids ?? [],
    prompt_version: use_case === "judge" ? getVersions().judge_prompt : getVersions().extraction_prompt,
    system_text: input.system,
    run: (c, p, options) => c.messages.parse(p as Parameters<Anthropic["messages"]["parse"]>[0], options),
  });
  const parsed = (message as { parsed_output?: z.infer<S> | null }).parsed_output ?? null;
  return { ...record, message, parsed };
}

/** The judge: `messages.parse` with `zodOutputFormat` on the judge model. */
export function judgeCall<S extends z.ZodType>(ctx: Ctx, input: ParsedCallInput<S>): Promise<ParsedCallResult<S>> {
  return parsedCall(ctx, "judge", input);
}

/** Extraction: `messages.parse` with `zodOutputFormat` on the extraction model, one retry from the SDK options. */
export function extractCall<S extends z.ZodType>(ctx: Ctx, input: ParsedCallInput<S>): Promise<ParsedCallResult<S>> {
  return parsedCall(ctx, "extraction", input);
}
