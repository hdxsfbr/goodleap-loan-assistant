import { StreamLineSchema, type StreamLine } from "@shared/schemas";
import { INTERRUPTED_MESSAGE, WORKING_STATUS } from "./copy";
import { CONNECTION_ERROR, UNREADABLE_REPLY_ERROR } from "./errors";
import { displayCovers } from "./present";
import type { Exchange, OptionsLine, ProposalsLine, TurnState } from "./types";

// The pure half of a copilot turn: splitting the response body into lines, parsing a line, and
// folding lines into the state the panel renders. No DOM, no network.

/** Everything a turn can dispatch: the server's lines plus the end of the response body. */
export type ClientEvent = StreamLine | { type: "stream_ended" };

export interface LineReader {
  /** Feeds a decoded chunk and returns the complete lines it finished, in order. */
  push(chunk: string): string[];
  /** Returns the final line when the body ended without a newline. */
  flush(): string[];
}

/** Splits newline-delimited text arriving in arbitrary chunks. Blank lines are dropped. */
export function createLineReader(): LineReader {
  let pending = "";
  const clean = (line: string): string[] => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    return trimmed.trim() === "" ? [] : [trimmed];
  };
  return {
    push(chunk) {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      return parts.flatMap(clean);
    },
    flush() {
      const last = pending;
      pending = "";
      return clean(last);
    },
  };
}

export type ParsedLine = { ok: true; line: StreamLine } | { ok: false; reason: string };

/** Parses one line of the stream against the shared schema. */
export function parseStreamLine(raw: string): ParsedLine {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "The line is not JSON." };
  }
  const parsed = StreamLineSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: issue ? `${issue.path.join(".") || "line"}: ${issue.message}` : "The line is invalid." };
  }
  const line = parsed.data;
  if (line.type === "options" && !displayCovers(line.calculator_result.options, line.options_display)) {
    return { ok: false, reason: "options_display: an option has no display entry." };
  }
  return { ok: true, line };
}

export function startTurn(status: string = WORKING_STATUS): TurnState {
  return {
    phase: "running",
    status,
    options: null,
    proposals: null,
    explanation: null,
    fallback: null,
    error: null,
    event_ids: [],
  };
}

/** A finished turn that holds only a calculator result (the button that calls no model). */
export function turnFromOptions(line: OptionsLine): TurnState {
  return { ...startTurn(), phase: "done", status: null, options: line };
}

/** A finished turn that holds only an error. */
export function turnFromError(error: NonNullable<TurnState["error"]>): TurnState {
  return { ...startTurn(), phase: "error", status: null, error };
}

/** Folds one event into the turn. A settled turn only accepts the event ids of its `done` line. */
export function applyStreamEvent(turn: TurnState, event: ClientEvent): TurnState {
  if (turn.phase !== "running") {
    if (event.type === "done" && turn.event_ids.length === 0) return { ...turn, event_ids: event.event_ids };
    return turn;
  }
  switch (event.type) {
    case "status":
      return { ...turn, status: event.step };
    case "options":
      return { ...turn, options: event };
    case "proposals": {
      const ids = [...(turn.proposals?.ids ?? []), ...event.proposals.map((p) => p.id)];
      return { ...turn, proposals: { ids, note: event.note ?? turn.proposals?.note ?? null } };
    }
    case "explanation":
      return { ...turn, status: null, explanation: { text: event.text, question: event.question, footer: event.footer } };
    case "fallback":
      // The Compliance text stands in for the explanation; the blocked draft's text is never shown beside it.
      return {
        ...turn,
        status: null,
        explanation: null,
        fallback: { text: event.text, marker: event.marker, audit_event_id: event.audit_event_id },
      };
    case "error":
      return {
        ...turn,
        phase: "error",
        status: null,
        error: { code: event.code, message: event.message, retryable: event.retryable },
      };
    case "done":
      return { ...turn, phase: "done", status: null, event_ids: event.event_ids };
    case "stream_ended":
      return {
        ...turn,
        phase: "error",
        status: null,
        error: { code: "internal", message: INTERRUPTED_MESSAGE, retryable: true },
      };
  }
}

/** The ids of the contractor messages a proposals line points at, in first-seen order. */
export function messageIdsOf(line: ProposalsLine): string[] {
  const ids: string[] = [];
  for (const proposal of line.proposals) {
    if (proposal.source.kind !== "message") continue;
    const id = proposal.source.ref.message_id;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The text of the contractor message with this server id, when this page sent it. */
export function messageTextFor(exchanges: readonly Exchange[], messageId: string): string | null {
  const found = exchanges.find((exchange) => exchange.message_ids.includes(messageId));
  return found?.text ?? null;
}

/** The exchange that holds the newest options table of the chat, or null when no reply has shown one. */
export function latestOptionsExchange(exchanges: readonly Exchange[]): Exchange | null {
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = exchanges[index];
    if (exchange?.turn.options) return exchange;
  }
  return null;
}

/** The exchange that holds this server message id. */
export function exchangeForMessage(exchanges: readonly Exchange[], messageId: string): Exchange | null {
  return exchanges.find((exchange) => exchange.message_ids.includes(messageId)) ?? null;
}

/** True when the reply has something to show: content, an error or a status line. */
export function turnHasContent(turn: TurnState): boolean {
  return (
    turn.options !== null ||
    (turn.proposals?.ids.length ?? 0) > 0 ||
    turn.proposals?.note != null ||
    turn.explanation !== null ||
    turn.fallback !== null ||
    turn.error !== null ||
    (turn.phase === "running" && turn.status !== null)
  );
}

/**
 * Reads a response body as newline-delimited JSON and dispatches each line as it completes. Stops
 * at the first line that does not match the schema (dispatching an error) or when the body ends;
 * a read failure dispatches a connection error. Never throws.
 */
export async function readTurnBody(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ClientEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines = createLineReader();
  // True while the lines so far were all valid.
  const dispatch = (raw: string): boolean => {
    const parsed = parseStreamLine(raw);
    if (!parsed.ok) {
      console.error("copilot turn: a stream line did not match its schema:", parsed.reason);
      onEvent({ type: "error", ...UNREADABLE_REPLY_ERROR });
      return false;
    }
    onEvent(parsed.line);
    return true;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const raw of lines.push(decoder.decode(value, { stream: true }))) {
        if (!dispatch(raw)) {
          await reader.cancel();
          return;
        }
      }
    }
    for (const raw of [...lines.push(decoder.decode()), ...lines.flush()]) {
      if (!dispatch(raw)) return;
    }
  } catch {
    onEvent({ type: "error", ...CONNECTION_ERROR });
  }
}
