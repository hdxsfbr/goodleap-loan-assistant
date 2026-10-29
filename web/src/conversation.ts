import type { ErrorBody } from "@shared/schemas";
import { CALCULATING_STATUS } from "./copy";
import { toErrorBody } from "./errors";
import {
  applyStreamEvent,
  messageIdsOf,
  startTurn,
  turnFromError,
  turnFromOptions,
  type ClientEvent,
} from "./stream";
import type { ConversationState, Exchange, OptionsLine, SessionFlags } from "./types";

// The chat, kept outside the components so it survives a trip to the homeowner view and back.
// One conversation per application; one turn at a time.

export interface ConversationDeps {
  /** Posts a message and dispatches every event of the reply; ends with `stream_ended`. */
  stream: (applicationId: string, text: string, onEvent: (event: ClientEvent) => void) => Promise<void>;
  /** The calculator button: options for the form's amount, no model. */
  paymentOptions: (applicationId: string) => Promise<OptionsLine>;
}

const EMPTY: ConversationState = Object.freeze({ exchanges: [], revision: 0 });

export function createConversationStore(deps: ConversationDeps) {
  const conversations = new Map<string, ConversationState>();
  const listeners = new Set<() => void>();
  let flags: SessionFlags = { key_missing: false, key_rejected: false, copilot_disabled: false };
  let nextId = 1;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const get = (applicationId: string): ConversationState => conversations.get(applicationId) ?? EMPTY;

  const set = (applicationId: string, next: ConversationState) => {
    conversations.set(applicationId, next);
    emit();
  };

  const noteFailure = (error: ErrorBody) => {
    if (error.code === "llm.missing_key" && !flags.key_missing) flags = { ...flags, key_missing: true };
    else if (error.code === "llm.auth_failed" && !flags.key_rejected) flags = { ...flags, key_rejected: true };
    else if (error.code === "copilot.disabled" && !flags.copilot_disabled) {
      flags = { ...flags, copilot_disabled: true };
    } else return;
    emit();
  };

  const replaceExchange = (
    applicationId: string,
    exchangeId: string,
    change: (exchange: Exchange, taken: ReadonlySet<string>) => Exchange,
    bump: (before: Exchange, after: Exchange) => boolean,
  ) => {
    const current = get(applicationId);
    const taken = new Set(current.exchanges.flatMap((exchange) => exchange.message_ids));
    let bumped = false;
    const exchanges = current.exchanges.map((exchange) => {
      if (exchange.id !== exchangeId) return exchange;
      const next = change(exchange, taken);
      if (next !== exchange && bump(exchange, next)) bumped = true;
      return next;
    });
    set(applicationId, { exchanges, revision: bumped ? current.revision + 1 : current.revision });
  };

  const dispatch = (applicationId: string, exchangeId: string, event: ClientEvent) => {
    replaceExchange(
      applicationId,
      exchangeId,
      (exchange, taken) => {
        const turn = applyStreamEvent(exchange.turn, event);
        let messageIds = exchange.message_ids;
        if (event.type === "proposals") {
          const fresh = messageIdsOf(event).filter((id) => !taken.has(id));
          if (fresh.length > 0) messageIds = [...messageIds, ...fresh];
        }
        return turn === exchange.turn && messageIds === exchange.message_ids
          ? exchange
          : { ...exchange, turn, message_ids: messageIds };
      },
      (before, after) =>
        event.type === "proposals" || (before.turn.phase === "running" && after.turn.phase !== "running"),
    );
    if (event.type === "error") noteFailure(event);
  };

  const run = async (applicationId: string, exchangeId: string, text: string): Promise<void> => {
    try {
      await deps.stream(applicationId, text, (event) => dispatch(applicationId, exchangeId, event));
    } catch (error) {
      dispatch(applicationId, exchangeId, { type: "error", ...toErrorBody(error) });
    }
    // A stream that resolved without ending its turn was cut off.
    dispatch(applicationId, exchangeId, { type: "stream_ended" });
  };

  const runCalculator = async (applicationId: string, exchangeId: string): Promise<void> => {
    try {
      const line = await deps.paymentOptions(applicationId);
      replaceExchange(applicationId, exchangeId, (exchange) => ({ ...exchange, turn: turnFromOptions(line) }), () => false);
    } catch (error) {
      replaceExchange(
        applicationId,
        exchangeId,
        (exchange) => ({ ...exchange, turn: turnFromError(toErrorBody(error)) }),
        () => false,
      );
    }
  };

  const isBusy = (applicationId: string): boolean =>
    get(applicationId).exchanges.some((exchange) => exchange.turn.phase === "running");

  const append = (applicationId: string, exchange: Exchange) => {
    const current = get(applicationId);
    set(applicationId, { ...current, exchanges: [...current.exchanges, exchange] });
  };

  const newExchange = (text: string | null): Exchange => ({
    id: `x${nextId++}`,
    text,
    message_ids: [],
    turn: startTurn(text === null ? CALCULATING_STATUS : undefined),
  });

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getConversation: get,
    getFlags: (): SessionFlags => flags,
    isBusy,

    /** Sends a contractor message. Resolves when the reply has ended. A busy chat ignores it. */
    async sendMessage(applicationId: string, text: string): Promise<void> {
      const trimmed = text.trim();
      if (trimmed === "" || isBusy(applicationId)) return;
      const exchange = newExchange(trimmed);
      append(applicationId, exchange);
      await run(applicationId, exchange.id, trimmed);
    },

    /** Posts the same text again for an exchange whose reply failed with a retryable error. */
    async retry(applicationId: string, exchangeId: string): Promise<void> {
      const exchange = get(applicationId).exchanges.find((candidate) => candidate.id === exchangeId);
      if (!exchange || isBusy(applicationId)) return;
      if (exchange.turn.phase !== "error" || exchange.turn.error?.retryable !== true) return;
      replaceExchange(
        applicationId,
        exchangeId,
        (current) => ({ ...current, turn: startTurn(current.text === null ? CALCULATING_STATUS : undefined) }),
        () => false,
      );
      if (exchange.text === null) await runCalculator(applicationId, exchangeId);
      else await run(applicationId, exchangeId, exchange.text);
    },

    /** The calculator button: adds a calculator result (or its error) to the chat. */
    async showPaymentOptions(applicationId: string): Promise<void> {
      if (isBusy(applicationId)) return;
      const exchange = newExchange(null);
      append(applicationId, exchange);
      await runCalculator(applicationId, exchange.id);
    },
  };
}

export type ConversationStore = ReturnType<typeof createConversationStore>;
