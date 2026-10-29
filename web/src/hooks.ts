import { useSyncExternalStore } from "react";
import { requestPaymentOptions, streamTurn } from "./api";
import { createConversationStore } from "./conversation";
import type { ConversationState, SessionFlags } from "./types";

/** The page's one chat store. It outlives any screen, so the chat survives the homeowner view. */
export const conversationStore = createConversationStore({
  stream: streamTurn,
  paymentOptions: requestPaymentOptions,
});

export function useConversation(applicationId: string): ConversationState {
  const snapshot = () => conversationStore.getConversation(applicationId);
  return useSyncExternalStore(conversationStore.subscribe, snapshot, snapshot);
}

export function useSessionFlags(): SessionFlags {
  return useSyncExternalStore(conversationStore.subscribe, conversationStore.getFlags, conversationStore.getFlags);
}
