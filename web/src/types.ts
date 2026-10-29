import type { DisclosureBlock, ErrorBody, StreamLine } from "@shared/schemas";

// Types the shared schemas do not name. The stream line types are members of the `StreamLine` union.

export type OptionsLine = Extract<StreamLine, { type: "options" }>;
export type ProposalsLine = Extract<StreamLine, { type: "proposals" }>;

/** One option's pre-formatted disclosure cells. */
export type DisclosureOption = DisclosureBlock["options"][number];

export type TurnPhase = "running" | "done" | "error";

/** What the panel shows for one assistant reply, built line by line from the stream. */
export interface TurnState {
  phase: TurnPhase;
  /** The latest status step while the turn runs, else null. */
  status: string | null;
  /** The latest options line of the turn. */
  options: OptionsLine | null;
  /** Ids of the proposals the turn made, and the note that explains a failed suggestion. */
  proposals: { ids: string[]; note: string | null } | null;
  explanation: { text: string; footer: string | null } | null;
  fallback: { text: string; marker: string; audit_event_id: string } | null;
  error: ErrorBody | null;
  event_ids: string[];
}

/**
 * One exchange in the chat: the contractor's text and the assistant's reply to it. `text` is null
 * for a calculator result, which has no contractor message. `message_ids` are the server's ids of
 * the contractor's messages that proposals pointed at, so a proposal can find its bubble.
 */
export interface Exchange {
  id: string;
  text: string | null;
  message_ids: string[];
  turn: TurnState;
}

export interface ConversationState {
  exchanges: readonly Exchange[];
  /** Bumped when the server's copy of the application may have changed (proposals, end of turn). */
  revision: number;
}

/** What the session has learned about the assistant's availability from failed turns. */
export interface SessionFlags {
  key_missing: boolean;
  key_rejected: boolean;
  copilot_disabled: boolean;
}

/** A request to scroll to and highlight the chat message a proposal came from. */
export interface SourceFocus {
  message_id: string;
  nonce: number;
}
