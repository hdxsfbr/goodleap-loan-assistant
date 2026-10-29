// Context assembly for a copilot turn, in a fixed order: the stable prefix (the prompt file with
// the Compliance-owned fixed texts interpolated, the catalog read through the catalog service,
// the disclosure facts) carrying the cache breakpoint; then the volatile application state; then
// the last 10 contractor turns of the transcript, prior turns replayed as final text only.
// Nothing in the prefix varies per request: no timestamps, no ids.

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { APPLICATION_FIELDS, requiredFields } from "@shared/application-schema";
import { formatMoney } from "@shared/format";
import type { Catalog, TranscriptMessage } from "@shared/schemas";
import { audit, type Ctx } from "../audit-log.js";
import { deriveBanner } from "../domain/banner.js";
import {
  CHAT_FOOTER,
  ESTIMATE_STATEMENT,
  OUT_OF_SCOPE_ACTIONS,
  OUT_OF_SCOPE_REPLY,
  RESPA_LINE,
  WHAT_HAPPENS_NEXT,
} from "../guardrail/fallback.js";
import { allFigureTokens } from "../guardrail/number-match.js";
import { services, withMock } from "../services/index.js";
import { store } from "../store.js";

/** The model's window: the last 10 contractor turns and the replies between them. */
export const TURN_WINDOW = 10;

const OPTION_LETTERS = ["A", "B", "C"] as const;

let promptTemplate: string | undefined;

function promptFile(): string {
  promptTemplate ??= readFileSync(new URL("../prompts/copilot.system.md", import.meta.url), "utf8").trim();
  return promptTemplate;
}

/** The catalog as the prefix shows it: one block per product in option order. */
export function renderCatalogBlock(catalog: Catalog): string {
  return catalog.products
    .map((product, index) =>
      [
        `Option ${OPTION_LETTERS[index] ?? String(index + 1)} (product id ${product.id}): ${product.name}`,
        `Mechanic: ${product.mechanic}. Term: ${product.term_months} months.`,
        `Rules: ${product.rules}`,
        `In plain words: ${product.plain_sentence}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/** The fixed disclosure texts the app attaches by itself, so the model knows not to restate them. */
export function renderDisclosureFacts(): string {
  return [
    `- Under every payment table the app prints this line: "${CHAT_FOOTER}" Do not repeat it.`,
    `- The homeowner view prints, for each option, the APR, finance charge, amount financed and total of payments, then "${ESTIMATE_STATEMENT}" and "${RESPA_LINE}", then "${WHAT_HAPPENS_NEXT}"`,
    "- Every payment figure is an estimate. Nothing is decided in the app; the application goes to GoodLeap for review after it is submitted.",
  ].join("\n");
}

/** The stable system text: the prompt file with every placeholder filled. It throws on a placeholder it cannot fill. */
export function renderStablePrefix(catalog: Catalog): string {
  const values: Record<string, string> = {
    OUT_OF_SCOPE_REPLY,
    OUT_OF_SCOPE_ACTIONS: OUT_OF_SCOPE_ACTIONS.map((action) => `- ${action}`).join("\n"),
    CATALOG: renderCatalogBlock(catalog),
    DISCLOSURE_FACTS: renderDisclosureFacts(),
  };
  return promptFile().replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The copilot prompt has no value for {{${name}}}.`);
    return value;
  });
}

// Fields whose value the model may see. Everything else is reported as provided or missing, so the
// model never has the homeowner's name, address or income in front of it to repeat.
const VISIBLE_FIELDS = new Set([
  "project_type",
  "project_amount",
  "requested_loan_amount",
  "preferred_term_months",
  "selected_product_id",
]);

function showValue(fieldId: string, value: string | number): string {
  if (!VISIBLE_FIELDS.has(fieldId)) return "provided";
  return typeof value === "number" ? formatMoney(value) : value;
}

/** The volatile block: typed, confirmed and pending fields as a short list, and the flags. */
export function renderApplicationState(applicationId: string): string {
  const application = store.getApplication(applicationId);
  const lines: string[] = [];
  lines.push("Application state (current; the contractor edits it on the form):");
  lines.push(`- Status: ${application?.status ?? "unknown"}`);
  for (const def of APPLICATION_FIELDS) {
    const entry = application?.fields[def.id];
    lines.push(
      entry
        ? `- ${def.label}: ${showValue(def.id, entry.value)} (${entry.state})`
        : `- ${def.label}: not set`,
    );
  }
  const pending = store
    .listProposals(applicationId, { state: "proposed" })
    .filter((p) => !p.field_key.includes(".") && p.value !== null);
  if (pending.length > 0) {
    lines.push("Suggestions waiting for the contractor's confirmation:");
    for (const proposal of pending) {
      lines.push(`- ${proposal.field_key} = ${showValue(proposal.field_key, proposal.value as string | number)}`);
    }
  }
  const missing = requiredFields().filter((def) => !application?.fields[def.id]);
  lines.push(
    missing.length > 0
      ? `Required fields still empty: ${missing.map((def) => def.label).join(", ")}.`
      : "Required fields still empty: none.",
  );
  if (deriveBanner(store.listDiscrepancies(applicationId))) {
    lines.push("A reviewer has an open question for the contractor about a document. It shows on the form; do not discuss it.");
  }
  return lines.join("\n");
}

/** The transcript split into the model's window and what has left it. */
export function splitWindow(all: readonly TranscriptMessage[]): {
  kept: TranscriptMessage[];
  dropped: TranscriptMessage[];
} {
  const contractorAt = all.flatMap((message, index) => (message.role === "contractor" ? [index] : []));
  if (contractorAt.length <= TURN_WINDOW) return { kept: [...all], dropped: [] };
  const start = contractorAt[contractorAt.length - TURN_WINDOW] as number;
  return { kept: all.slice(start), dropped: all.slice(0, start) };
}

/** Window messages as API messages: contractor text with its `[m_12]` id, replies as final text only; same-role neighbors merged. */
export function toApiMessages(kept: readonly TranscriptMessage[]): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of kept) {
    const role = message.role === "contractor" ? "user" : "assistant";
    const content = message.role === "contractor" ? `[${message.id}] ${message.text}` : message.text;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  }
  return out;
}

export interface TurnContext {
  system: Anthropic.TextBlockParam[];
  /** The window as API messages; the current contractor message is last. */
  messages: Anthropic.MessageParam[];
  /** Transcript ids of the window. */
  message_ids: string[];
  /** The catalog snapshot the prefix was built from; the calculator prices from the same one. */
  catalog: Catalog;
  /** Figures the contractor typed in the window, in canonical spelling. */
  contractor_figures: string[];
}

/**
 * Builds the request context for a turn. Reads the catalog through the catalog service (one
 * `tool.call`), and appends one `context.compacted` event for the messages that left the window
 * on this turn for the first time. `ctx` is the turn's context; the current message is already in
 * the transcript.
 */
export async function buildContext(ctx: Ctx): Promise<TurnContext> {
  const { _mock: _ignored, ...catalog } = await withMock(ctx, "catalog", "getCatalog", () =>
    services.catalog.getCatalog(),
  );
  const { kept, dropped } = splitWindow(store.listMessages(ctx.application_id));

  const alreadyDropped = new Set(
    audit
      .list(ctx.application_id)
      .flatMap((event) => (event.type === "context.compacted" ? event.dropped_message_ids : [])),
  );
  const newlyDropped = dropped.map((message) => message.id).filter((id) => !alreadyDropped.has(id));
  if (newlyDropped.length > 0) {
    audit.emit({ ...ctx, actor: { type: "system", id: "copilot" } }, "context.compacted", {
      dropped_message_ids: newlyDropped,
    });
  }

  return {
    system: [
      { type: "text", text: renderStablePrefix(catalog), cache_control: { type: "ephemeral" } },
      { type: "text", text: renderApplicationState(ctx.application_id) },
    ],
    messages: toApiMessages(kept),
    message_ids: kept.map((message) => message.id),
    catalog,
    contractor_figures: kept
      .filter((message) => message.role === "contractor")
      .flatMap((message) => allFigureTokens(message.text)),
  };
}
