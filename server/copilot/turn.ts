// A copilot turn (Technical Plan 4.1): the contractor's message in, staged stream lines out.
// Manual tool loop over the stable messages endpoint; every step appends an audit event carrying
// the turn id and its parent, so the chain from the contractor's text to what was shown is a walk
// up the parents. Model prose is shown only after the three guardrail checks pass.

import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { fieldDef, zodForField } from "@shared/application-schema";
import {
  StreamLineSchema,
  type GuardrailAllowed,
  type OptionsRecord,
  type ProposedValue,
  type StreamLine,
} from "@shared/schemas";
import { audit, type Ctx } from "../audit-log.js";
import { appendMessage, attachExplanation, proposeFieldValue } from "../commands.js";
import { COPILOT_ROUND_CAP, effectiveModelId, PINNED_MODELS } from "../config.js";
import { calculatorValues, calculatorValuesForResult } from "../domain/payments/calculator.js";
import { AppError, CommandError, toErrorResponse } from "../errors.js";
import { EMPTY_DRAFT_REASON, runGuardrail, type GuardrailResult } from "../guardrail/index.js";
import {
  CHAT_FOOTER,
  FALLBACK_MARKER,
  FALLBACK_REPLY,
  STATUS_STEPS,
} from "../guardrail/fallback.js";
import { copilotCall, ModelCallError, type CopilotCallResult } from "../llm/client.js";
import { store } from "../store.js";
import { buildContext } from "./context.js";
import { optionsToolResult, priceAndStore } from "./options.js";
import { quoteSupportsValue, verifyQuote } from "./quote-verify.js";
import {
  CALCULATE_PAYMENT,
  CalculatePaymentArgsSchema,
  PROPOSE_FIELD_FILL,
  ProposeFieldFillArgsSchema,
  TOOLS,
} from "./tools.js";

export type Write = (line: StreamLine) => void;

type ToolResult = Anthropic.ToolResultBlockParam;

const SCHEMA_INVALID_NOTE = new AppError("llm.schema_invalid").message;

/** What the model is told when a draft had no text, in place of the audit rationale `empty_draft`. */
const EMPTY_DRAFT_INSTRUCTION = "The reply was empty.";

/** What the prompt tells the model to start the one question for the contractor with, on the final line. */
export const QUESTION_MARKER = "Question for you:";

/**
 * Splits the contractor's question off a judged draft. The question is the final line when that line
 * starts with the marker and the marker appears nowhere else in the draft; the body is everything
 * before it. A marker anywhere else (in the middle of the draft, twice, or not at the start of the
 * final line) means the draft has no question, and the text is returned as it is. A final line that
 * is the bare marker, after other text, is dropped and yields no question.
 */
export function splitQuestion(draft: string): { body: string; question: string | null } {
  const text = draft.trim();
  const lineStart = text.lastIndexOf("\n") + 1;
  const last = text.slice(lineStart).trim();
  const before = text.slice(0, lineStart);
  if (!last.startsWith(QUESTION_MARKER)) return { body: draft, question: null };
  const question = last.slice(QUESTION_MARKER.length).trim();
  if (before.includes(QUESTION_MARKER) || question.includes(QUESTION_MARKER)) return { body: draft, question: null };
  const body = before.trim();
  if (body === "" && question === "") return { body: draft, question: null };
  return { body, question: question === "" ? null : question };
}

/** All text blocks of a response, joined. Interim text in a tool round never reaches this. */
function textOf(message: Anthropic.Message): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
    .trim();
}

/** A response's content as the assistant turn of the next request: verbatim, thinking blocks included. */
function replayed(message: Anthropic.Message): Anthropic.MessageParam {
  return { role: "assistant", content: message.content as unknown as Anthropic.ContentBlockParam[] };
}

function regenerateInstruction(reasons: readonly string[]): string {
  return (
    `The wording check blocked that draft: ${reasons.join(" ")}\n\n` +
    "Write the reply again so that it avoids the problem. Keep to every rule, use only figures copied exactly " +
    "from the calculation result or typed by the contractor, and write only the new reply."
  );
}

/**
 * Runs one turn. Writes `status`, `options`, `proposals`, `explanation` or `fallback`, `error` and
 * always a final `done`. Never throws: every failure becomes an `error` line.
 */
export async function runTurn(base: Ctx, text: string, write: Write): Promise<void> {
  const turn_id = `turn_${randomUUID()}`;
  const modelActor = { type: "model", id: effectiveModelId(PINNED_MODELS.copilot) } as const;
  const copilotActor = { type: "system", id: "copilot" } as const;
  const at = (parent?: string, actor?: Ctx["actor"]): Ctx => ({
    ...base,
    turn_id,
    ...(parent === undefined ? {} : { parent_event_id: parent }),
    ...(actor === undefined ? {} : { actor }),
  });
  // Every line is checked against the stream contract before it leaves.
  const emit = (line: StreamLine): void => write(StreamLineSchema.parse(line));
  const turnEventIds = (): string[] =>
    audit
      .list(base.application_id)
      .filter((event) => event.turn_id === turn_id)
      .map((event) => event.event_id);

  try {
    await execute();
  } catch (err) {
    try {
      if (!(err instanceof AppError) && !(err instanceof CommandError)) {
        console.error("Unexpected error in a copilot turn:", err instanceof Error ? err.message : err);
      }
      emit({ type: "error", ...toErrorResponse(err).body });
    } catch {
      // The stream is gone; the audit log already holds the turn.
    }
  }
  try {
    emit({ type: "done", event_ids: turnEventIds() });
  } catch {
    // Nothing left to tell.
  }

  async function execute(): Promise<void> {
    emit({ type: "status", step: STATUS_STEPS[0] });
    const received = appendMessage(at(), text);
    const context = await buildContext(at(received.event_id));

    const conversation: Anthropic.MessageParam[] = [...context.messages];
    let parent = received.event_id;
    let lastOptions: OptionsRecord | undefined;
    let draftCall: CopilotCallResult | undefined;

    const fallback = (audit_event_id: string): void => {
      appendMessage(at(audit_event_id, modelActor), FALLBACK_REPLY);
      emit({ type: "fallback", text: FALLBACK_REPLY, marker: FALLBACK_MARKER, audit_event_id });
    };

    /** One model call; a refusal is a block, so it ends in the fallback (`undefined`). */
    const call = async (): Promise<CopilotCallResult | undefined> => {
      try {
        return await copilotCall(at(parent), {
          system: context.system,
          messages: conversation,
          tools: TOOLS,
          message_ids: context.message_ids,
        });
      } catch (err) {
        if (err instanceof ModelCallError && err.code === "llm.refusal") {
          fallback(err.event_id);
          return undefined;
        }
        throw err;
      }
    };

    // The tool loop: at most COPILOT_ROUND_CAP model rounds. Another round of tool use after the
    // last one, or a reply cut off at the token cap, is a block.
    for (let round = 1; ; round++) {
      if (round > 1) emit({ type: "status", step: STATUS_STEPS[2] });
      const response = await call();
      if (!response) return;
      parent = response.event_id;
      const stop = response.message.stop_reason;
      if (stop === "max_tokens") return fallback(response.event_id);
      if (stop !== "tool_use") {
        draftCall = response;
        break;
      }
      if (round >= COPILOT_ROUND_CAP) return fallback(response.event_id);
      conversation.push(replayed(response.message));
      const results = await runTools(response);
      conversation.push({ role: "user", content: results });
    }

    // The guardrail: all three checks on every draft, one regeneration, then the fallback.
    const allowed = (): GuardrailAllowed => ({
      calculator_values: lastOptions ? calculatorValuesForResult(lastOptions.calculator_output) : [],
      contractor_figures: context.contractor_figures,
      // Each option's own figures, so one option's payment cannot be attached to another.
      ...(lastOptions
        ? {
            option_values: Object.fromEntries(
              lastOptions.calculator_output.options.map((option) => [option.label, calculatorValues(option)]),
            ),
          }
        : {}),
    });
    // An empty draft goes through the guardrail like any other: it records a block on every layer.
    const check = async (draft: string, from: CopilotCallResult): Promise<GuardrailResult> => {
      emit({ type: "status", step: STATUS_STEPS[3] });
      return runGuardrail(at(from.event_id), draft, allowed());
    };
    const blockedReasons = (result: GuardrailResult): string[] => [
      ...new Set(
        result.verdicts
          .filter((verdict) => verdict.outcome === "blocked")
          .map((verdict) =>
            verdict.reason === EMPTY_DRAFT_REASON ? EMPTY_DRAFT_INSTRUCTION : (verdict.reason ?? verdict.layer),
          ),
      ),
    ];

    let draft = textOf(draftCall.message);
    let result = await check(draft, draftCall);
    if (!result.pass) {
      const reasons = blockedReasons(result);
      // A judge outage alone gives the model nothing to fix; it goes straight to the fallback.
      if (reasons.length === 0) return fallback(result.blocking_event_id ?? draftCall.event_id);
      conversation.push(replayed(draftCall.message));
      conversation.push({ role: "user", content: regenerateInstruction(reasons) });
      parent = result.event_ids[result.event_ids.length - 1] ?? draftCall.event_id;
      emit({ type: "status", step: STATUS_STEPS[2] });
      const second = await call();
      if (!second) return;
      parent = second.event_id;
      if (second.message.stop_reason !== "end_turn") return fallback(second.event_id);
      draftCall = second;
      draft = textOf(second.message);
      result = await check(draft, second);
      if (!result.pass) return fallback(result.blocking_event_id ?? second.event_id);
    }

    // Passed, question included: the body is the explanation, stored and shown to the homeowner too;
    // the question is for the contractor alone. A draft that is only a question has no explanation to
    // store: it is the reply the contractor reads, and the homeowner view keeps its canned sentences.
    const split = splitQuestion(draft);
    const reply =
      split.body === "" && split.question !== null
        ? { text: split.question, question: null, explains: false }
        : { text: split.body, question: split.question, explains: true };
    const shown = appendMessage(at(draftCall.event_id, modelActor), draft);
    if (lastOptions && reply.explains) {
      attachExplanation(at(shown.event_id, copilotActor), lastOptions.options_id, reply.text, reply.question);
    }
    emit({
      type: "explanation",
      text: reply.text,
      question: reply.question,
      footer: lastOptions ? CHAT_FOOTER : null,
      event_ids: turnEventIds(),
    });

    // ---------------------------------------------------------------------------------------
    // Tool execution
    // ---------------------------------------------------------------------------------------

    async function runTools(response: CopilotCallResult): Promise<ToolResult[]> {
      const results: ToolResult[] = [];
      const proposals: ProposedValue[] = [];
      let note: string | null = null;
      let toolParent = response.event_id;

      for (const block of response.message.content) {
        if (block.type !== "tool_use") continue;
        const ok = (content: string): ToolResult => ({ type: "tool_result", tool_use_id: block.id, content });
        const failed = (content: string): ToolResult => ({
          type: "tool_result",
          tool_use_id: block.id,
          content,
          is_error: true,
        });

        if (block.name === CALCULATE_PAYMENT) {
          const args = CalculatePaymentArgsSchema.safeParse(block.input);
          if (!args.success) {
            // The model gets the error to retry; the contractor gets the schema-invalid note.
            note = SCHEMA_INVALID_NOTE;
            results.push(failed("Invalid arguments. amount_cents must be a positive whole number of cents."));
            continue;
          }
          emit({ type: "status", step: STATUS_STEPS[1] });
          try {
            const priced = await priceAndStore(at(toolParent), {
              catalog: context.catalog,
              amount_arg: args.data.amount_cents,
              term_arg: args.data.term_months,
              product_ids: args.data.product_ids,
            });
            lastOptions = priced.record;
            toolParent = priced.stored_event_id;
            emit(priced.line);
            results.push(ok(optionsToolResult(priced)));
          } catch (err) {
            // A bad amount or term goes back to the model to ask about, and its message is the contractor's
            // note; a catalog fault ends the turn.
            if (err instanceof CommandError) {
              note = err.message;
              results.push(failed(err.message));
            } else throw err;
          }
        } else if (block.name === PROPOSE_FIELD_FILL) {
          const outcome = proposeFromTool(block.input, toolParent);
          if (outcome.proposal) proposals.push(outcome.proposal);
          if (outcome.note) note = outcome.note;
          toolParent = outcome.event_id ?? toolParent;
          results.push(outcome.ok ? ok(outcome.message) : failed(outcome.message));
        } else {
          results.push(failed(`There is no tool named ${block.name}.`));
        }
      }

      if (proposals.length > 0 || note) emit({ type: "proposals", proposals, note });
      parent = toolParent;
      return results;
    }

    /** `propose_field_fill`: the backend decides. A quote must appear in the cited contractor message. */
    function proposeFromTool(
      input: unknown,
      toolParent: string,
    ): { ok: boolean; message: string; proposal?: ProposedValue; note?: string; event_id?: string } {
      const args = ProposeFieldFillArgsSchema.safeParse(input);
      if (!args.success) {
        return { ok: false, message: "Invalid arguments for the suggestion.", note: SCHEMA_INVALID_NOTE };
      }
      const { field, value, message_id, verbatim_quote } = args.data;
      const modelCtx = at(toolParent, modelActor);
      const source = { kind: "message", ref: { message_id, quote: verbatim_quote } } as const;

      const cited = store.getMessage(message_id);
      const citedText = cited && cited.application_id === base.application_id && cited.role === "contractor" ? cited.text : null;
      if (citedText === null || !verifyQuote(verbatim_quote, citedText).ok) {
        const dropped = audit.emit(modelCtx, "field.proposed", {
          proposal_id: null,
          field_key: field,
          value,
          source,
          dropped_reason: "quote_not_verified",
        });
        return {
          ok: false,
          message:
            "Not recorded: the quote does not appear word for word in that contractor message. Quote the contractor's exact words from the message that states it.",
          event_id: dropped.event_id,
        };
      }

      const parsed = zodForField(field).safeParse(value);
      if (!parsed.success) {
        return {
          ok: false,
          message: `Not recorded: ${parsed.error.issues[0]?.message ?? "that value is not valid for the field."}`,
          note: SCHEMA_INVALID_NOTE,
        };
      }

      // A real quote must also state the value proposed with it: "$30K" cannot carry $40K.
      const def = fieldDef(field);
      if (def && !quoteSupportsValue(def, value, parsed.data, verbatim_quote)) {
        const dropped = audit.emit(modelCtx, "field.proposed", {
          proposal_id: null,
          field_key: field,
          value,
          source,
          dropped_reason: "quote_not_verified",
        });
        return {
          ok: false,
          message:
            "Not recorded: the quote does not state that value. Suggest only the value the contractor's own words state, quoted exactly.",
          note: SCHEMA_INVALID_NOTE,
          event_id: dropped.event_id,
        };
      }
      try {
        const proposed = proposeFieldValue(modelCtx, { field_key: field, value: parsed.data, source });
        if (proposed.proposal) {
          return {
            ok: true,
            message: "Recorded as a suggestion for the contractor to confirm or dismiss.",
            proposal: proposed.proposal,
            event_id: proposed.event_id,
          };
        }
        return {
          ok: true,
          message:
            proposed.dropped_reason === "equals_confirmed"
              ? "Not recorded: the form already holds that value."
              : "Not recorded: that field is not filled by suggestion.",
          event_id: proposed.event_id,
        };
      } catch (err) {
        if (err instanceof CommandError) return { ok: false, message: `Not recorded: ${err.message}` };
        throw err;
      }
    }
  }
}
