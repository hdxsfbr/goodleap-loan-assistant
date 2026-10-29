import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import * as z from "zod/v4";
import { modelFields, type DocumentFieldDef, type DocumentSchema } from "@shared/document-schemas/index";
import { PROJECT_ROOT } from "../versions.js";
import type { Selection } from "./match.js";
import { toIndexedLines, type PositionedText } from "./positioned-text.js";

// The extraction prompt and the output schema, both generated from the document schema. The
// model receives positioned text only, rendered as indexed lines; it returns, per field, the
// value as written and the line and token span it read it from, with a verbatim quote. The
// backend verifies the quote (match.ts); the model never produces a coordinate.

const SYSTEM_PROMPT_PATH = `${PROJECT_ROOT}server/prompts/extraction.system.md`;

let systemPrompt: string | undefined;

/** The Compliance-reviewed extraction instructions, read once. */
export function loadSystemPrompt(): string {
  systemPrompt ??= readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  return systemPrompt;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /** The indexed lines on their own. */
  lines: string;
  /** Hash of `lines`: the fixture records it, so an indexer change that invalidates it is caught. */
  lines_sha256: string;
}

function describeField(field: DocumentFieldDef): string {
  const kind = field.type === "enum" ? `one of ${(field.options ?? []).join(", ")}, as written` : field.type;
  return `- ${field.id} (${kind}): ${field.description}`;
}

/** The slot description, the field list with descriptions, and the indexed lines. */
export function buildExtractionPrompt(schema: DocumentSchema, text: PositionedText): BuiltPrompt {
  const lines = toIndexedLines(text);
  const user = [
    `Expected document: ${schema.title}. ${schema.description}`,
    "",
    "Fields to find:",
    ...modelFields(schema).map(describeField),
    "",
    `The document has ${text.pages.length} ${text.pages.length === 1 ? "page" : "pages"}. Its text:`,
    "<document_text>",
    lines,
    "</document_text>",
  ].join("\n");
  return {
    system: loadSystemPrompt(),
    user,
    lines,
    lines_sha256: createHash("sha256").update(lines).digest("hex"),
  };
}

export interface ExtractionRequest {
  system: string;
  user: string;
  format: { type: "json_schema"; schema: Record<string, unknown> };
}

/**
 * Everything the model is shown for one document: the Compliance-reviewed instructions, the
 * prompt with the field list and the indexed lines, and the output format. The consumer sends
 * exactly this, and the fixture's `request_sha256` is the hash of it.
 */
export function buildExtractionRequest(schema: DocumentSchema, text: PositionedText): ExtractionRequest {
  const prompt = buildExtractionPrompt(schema, text);
  return { system: prompt.system, user: prompt.user, format: outputFormatFor(schema) };
}

/**
 * Hash of a request, covering the system prompt, the user prompt (indexed lines included) and the
 * output format, in the order they are sent. A change to any of them, or to the indexer or a
 * document schema that feed them, changes the hash.
 */
export function requestSha256(request: { system: string; user: string; format: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify({ system: request.system, user: request.user, format: request.format }))
    .digest("hex");
}

const SelectionSchema = z.object({
  value: z.string(),
  page: z.number().int(),
  line: z.number().int(),
  token_start: z.number().int(),
  token_end: z.number().int(),
  quoted_text: z.string(),
});

/**
 * `{ document_matches_slot, fields: { [field_id]: selection | null } }` for one document schema.
 * Every field key is present; a field that is not on the document is `null`. The field is nullable
 * as a whole, not member by member: structured outputs allow only 16 union-typed parameters per
 * schema, and six nullable members on each of seven pay stub fields would be 42. Values are the
 * as-written strings: parsing to cents, dates and enum values happens after location.
 */
export function outputSchemaFor(schema: DocumentSchema) {
  const shape: Record<string, z.ZodNullable<typeof SelectionSchema>> = {};
  for (const field of modelFields(schema)) shape[field.id] = SelectionSchema.nullable();
  return z.object({ document_matches_slot: z.boolean(), fields: z.object(shape) });
}

export interface ExtractionOutput {
  document_matches_slot: boolean;
  /** `null` for a field the model did not find. */
  fields: Record<string, Selection | null>;
}

/**
 * The `output_config.format` for one document schema: the JSON schema of `outputSchemaFor`, every
 * field spelled out, with the SDK's transform for structured outputs applied (closed objects,
 * all keys required). The integer bounds zod adds are dropped; the validation in code keeps them.
 */
export function outputFormatFor(schema: DocumentSchema): { type: "json_schema"; schema: Record<string, unknown> } {
  const json = z.toJSONSchema(outputSchemaFor(schema), {
    io: "output",
    override: (context) => {
      if (context.jsonSchema.type === "integer") {
        delete context.jsonSchema.minimum;
        delete context.jsonSchema.maximum;
      }
    },
  });
  const format = jsonSchemaOutputFormat(json as { type: "object" } & Record<string, unknown>);
  return { type: "json_schema", schema: JSON.parse(JSON.stringify(format.schema)) as Record<string, unknown> };
}

export type ParsedOutput = { ok: true; output: ExtractionOutput } | { ok: false; error: string };

/** Parses the model's text as JSON and validates it against the schema's output shape. */
export function parseExtractionOutput(schema: DocumentSchema, text: string): ParsedOutput {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "The response was not JSON." };
  }
  const parsed = outputSchemaFor(schema).safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first?.path.join(".") ?? "response"}: ${first?.message ?? "invalid"}` };
  }
  return { ok: true, output: parsed.data as ExtractionOutput };
}
