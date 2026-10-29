import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { DocumentSlot, ErrorCode } from "@shared/schemas";
import { audit, type Ctx } from "../audit-log.js";
import { config, useCases } from "../config.js";
import { AppError, mapSdkError } from "../errors.js";
import { PROJECT_ROOT, getVersions } from "../versions.js";

// The extraction model call. It is deliberately small and self-contained: one structured-output
// request per document, the response text returned, and one `model.call` audit event holding the
// full request and response. When the main LLM client lands (server/llm/client.ts) the call below
// can move behind it; nothing else in server/extraction depends on how the request is sent.

/** What the extraction asks of the model. */
export interface ModelCallRequest {
  system: string;
  user: string;
  format: { type: "json_schema"; schema: Record<string, unknown> };
}

export interface ModelCallResult {
  /** The `model.call` event that holds the request and response. */
  event_id: string;
  model_id: string;
  /** The concatenated text blocks of the response: the JSON the schema describes. */
  text: string;
  stop_reason: string | null;
}

export type ModelCaller = (ctx: Ctx, request: ModelCallRequest) => Promise<ModelCallResult>;

/** The JSON-clean copy of a value, as the audit file will hold it. */
function jsonClean<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The request body sent to the API, also recorded as the event's `raw_input`. */
export function requestBody(request: ModelCallRequest, model?: string) {
  const extraction = useCases().extraction;
  return {
    model: model ?? extraction.model,
    max_tokens: extraction.max_tokens,
    system: request.system,
    messages: [{ role: "user" as const, content: request.user }],
    output_config: { effort: extraction.effort, format: request.format },
  };
}

/**
 * The SDK appends `/v1/messages` to its base URL, so a base URL that already ends in `/v1`
 * (OpenRouter's documented form, `https://openrouter.ai/api/v1`) would be requested at
 * `/v1/v1/messages` and answered with a 404. The trailing `/v1` is dropped here.
 */
export function sdkBaseUrl(url: string | undefined = config.llmBaseUrl): string | undefined {
  return url?.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

interface EventFields {
  model_id: string;
  raw_input: unknown;
  raw_output: unknown;
  usage: { input: number; output: number; cache_read: number };
  latency_ms: number;
  stop_reason: string | null;
  error_code?: ErrorCode;
  fixture?: boolean;
}

function appendModelCall(ctx: Ctx, request: ModelCallRequest, fields: EventFields): string {
  const extraction = useCases().extraction;
  const event = audit.emit(
    { ...ctx, actor: { type: "model", id: fields.model_id } },
    "model.call",
    {
      use_case: "extraction",
      model_id: fields.model_id,
      effort: extraction.effort,
      context: {
        message_ids: [],
        system_prompt_version: getVersions().extraction_prompt,
        system_prompt_sha256: sha256(request.system),
      },
      raw_input: fields.raw_input,
      raw_output: fields.raw_output,
      usage: fields.usage,
      latency_ms: fields.latency_ms,
      stop_reason: fields.stop_reason,
      ...(fields.error_code === undefined ? {} : { error_code: fields.error_code }),
      ...(fields.fixture === true ? { _fixture: true } : {}),
    },
  );
  return event.event_id;
}

const ZERO_USAGE = { input: 0, output: 0, cache_read: 0 };

/**
 * Sends one extraction request and records it. A transport or API failure is mapped to its
 * `llm.*` code, recorded on the event and thrown as an `AppError`; so are a refusal and an answer
 * cut off at the token limit (`llm.schema_invalid`, since its JSON cannot be complete).
 */
export const extractCall: ModelCaller = async (ctx, request) => {
  if (!config.hasLlmKey) throw new AppError("llm.missing_key");
  const extraction = useCases().extraction;
  const body = requestBody(request);
  const rawInput = jsonClean(body);
  // The SDK reads ANTHROPIC_API_KEY from the environment. Retries are the consumer's job (one).
  const client = new Anthropic({ maxRetries: 0, timeout: extraction.sdk.timeout, baseURL: sdkBaseUrl() });

  const started = performance.now();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create(body);
  } catch (err) {
    const mapped = mapSdkError(err);
    appendModelCall(ctx, request, {
      model_id: body.model,
      raw_input: rawInput,
      // The provider's own words, so an audit reader can see why the call failed. Never the key.
      raw_output: {
        error: mapped.message,
        status: err instanceof Anthropic.APIError ? (err.status ?? null) : null,
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      },
      usage: ZERO_USAGE,
      latency_ms: Math.round(performance.now() - started),
      stop_reason: null,
      error_code: mapped.code,
    });
    throw mapped;
  }
  const latency = Math.round(performance.now() - started);
  const text = textOf(message.content as ReadonlyArray<{ type: string; text?: string }>);
  const stopReason = message.stop_reason ?? null;
  const failure: ErrorCode | undefined =
    stopReason === "refusal" ? "llm.refusal" : stopReason === "max_tokens" ? "llm.schema_invalid" : undefined;
  const eventId = appendModelCall(ctx, request, {
    model_id: message.model ?? body.model,
    raw_input: rawInput,
    raw_output: jsonClean(message),
    usage: {
      input: message.usage?.input_tokens ?? 0,
      output: message.usage?.output_tokens ?? 0,
      cache_read: message.usage?.cache_read_input_tokens ?? 0,
    },
    latency_ms: latency,
    stop_reason: stopReason,
    ...(failure === undefined ? {} : { error_code: failure }),
  });
  if (failure !== undefined) throw new AppError(failure);
  return { event_id: eventId, model_id: message.model ?? body.model, text, stop_reason: stopReason };
};

// ---------------------------------------------------------------------------------------------
// The recorded fixture: one real response per sample document, replayed when there is no key
// ---------------------------------------------------------------------------------------------

export const FIXTURE_PATH = `${PROJECT_ROOT}samples/extraction-fixture.json`;

const FixtureEntrySchema = z.object({
  /** The sample file the response was recorded against. */
  document: z.string(),
  model_id: z.string(),
  effort: z.string(),
  system_prompt_version: z.string(),
  /** Hash of the indexed lines the model was shown; the replay test compares it to the current indexer. */
  lines_sha256: z.string(),
  /**
   * Hash of the whole request the response answers: the system prompt, the user prompt and the
   * output format (`requestSha256`). The replay test compares it to the request built today, so a
   * change to the prompt, a document schema or the indexer fails the suite until it is recorded again.
   */
  request_sha256: z.string(),
  latency_ms: z.number(),
  usage: z.object({ input: z.number(), output: z.number(), cache_read: z.number() }),
  stop_reason: z.string().nullable(),
  /** The API response exactly as received. */
  response: z.object({ content: z.array(z.object({ type: z.string() }).passthrough()) }).passthrough(),
});

export const FixtureFileSchema = z.object({
  version: z.literal(1),
  recorded_at: z.string(),
  entries: z.record(FixtureEntrySchema),
});
export type FixtureFile = z.infer<typeof FixtureFileSchema>;
export type FixtureEntry = z.infer<typeof FixtureEntrySchema>;

export function loadFixture(path: string = FIXTURE_PATH): FixtureFile {
  return FixtureFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * A `ModelCaller` that answers from the recorded response for `slot` and appends the same
 * `model.call` event a live call would, with `_fixture: true`: the built prompt as `raw_input` and
 * the recorded response as `raw_output`. Throws `llm.missing_key` when no response was recorded.
 */
export function fixtureCaller(slot: DocumentSlot, path: string = FIXTURE_PATH): ModelCaller {
  return async (ctx, request) => {
    let entry: FixtureEntry | undefined;
    try {
      entry = loadFixture(path).entries[slot];
    } catch {
      entry = undefined;
    }
    if (!entry) throw new AppError("llm.missing_key");
    const text = textOf(entry.response.content as ReadonlyArray<{ type: string; text?: string }>);
    const eventId = appendModelCall(ctx, request, {
      model_id: entry.model_id,
      raw_input: jsonClean(requestBody(request, entry.model_id)),
      raw_output: entry.response,
      usage: entry.usage,
      latency_ms: entry.latency_ms,
      stop_reason: entry.stop_reason,
      fixture: true,
    });
    return { event_id: eventId, model_id: entry.model_id, text, stop_reason: entry.stop_reason };
  };
}
