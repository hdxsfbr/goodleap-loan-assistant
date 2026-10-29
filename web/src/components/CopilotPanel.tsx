import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ApplicationView } from "@shared/schemas";
import { createHomeownerView } from "../api";
import {
  COPILOT_DISABLED_MESSAGE,
  KEY_MISSING_MESSAGE,
  KEY_REJECTED_MESSAGE,
  NO_MODEL_CAPTION,
  OLDER_OPTIONS_CAPTION,
  SUGGESTED_PROMPTS,
} from "../copy";
import { toErrorBody } from "../errors";
import { conversationStore, useConversation, useSessionFlags } from "../hooks";
import { useHealth } from "../health";
import { hasRequestedAmount, proposalCountText } from "../present";
import { auditPath, homeownerPath } from "../routes";
import { exchangeForMessage, latestOptionsExchange, turnHasContent } from "../stream";
import type { Exchange, SourceFocus, TurnState } from "../types";
import { ArrowUpIcon, ChevronRightIcon, SparkleIcon } from "./Icons";
import { OptionsTable } from "./OptionsTable";

interface CopilotPanelProps {
  applicationId: string;
  /** The application as the form holds it; null until it has loaded. */
  view: ApplicationView | null;
  /** A request to scroll to and highlight the message a proposal came from. */
  focus: SourceFocus | null;
}

const MAX_MESSAGE_LENGTH = 4000;
const HIGHLIGHT_MS = 2400;

/** The assistant beside the form: suggested prompts, the chat, the calculator button and the composer. */
export function CopilotPanel({ applicationId, view, focus }: CopilotPanelProps) {
  const health = useHealth();
  const flags = useSessionFlags();
  const conversation = useConversation(applicationId);
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [openingView, setOpeningView] = useState<string | null>(null);
  const [viewFailure, setViewFailure] = useState<{ optionsId: string; message: string } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const exchanges = conversation.exchanges;
  const busy = exchanges.some((exchange) => exchange.turn.phase === "running");
  // Only the newest options table opens the homeowner view; older ones keep their numbers.
  const latestOptions = latestOptionsExchange(exchanges);
  const disabledByOperator = health?.copilot_enabled === false || flags.copilot_disabled;
  const keyProblem = flags.key_rejected
    ? KEY_REJECTED_MESSAGE
    : flags.key_missing || health?.has_llm_key === false
      ? KEY_MISSING_MESSAGE
      : null;
  const assistantAvailable = !disabledByOperator && keyProblem === null;
  const amountReady = hasRequestedAmount(view);

  // Keep the newest content in view as lines arrive.
  useEffect(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [exchanges]);

  // A proposal's badge asks for its source message.
  useEffect(() => {
    if (!focus) return undefined;
    const exchange = exchangeForMessage(exchanges, focus.message_id);
    if (!exchange) return undefined;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    document.getElementById(bubbleId(exchange.id))?.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    setHighlighted(exchange.id);
    const timer = window.setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
    // Only a new focus request should run this, not every line of the chat.
  }, [focus]);

  function send(text: string) {
    if (!assistantAvailable || busy || text.trim() === "") return;
    void conversationStore.sendMessage(applicationId, text);
    setDraft("");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    send(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft);
    }
  }

  async function openHomeownerView(optionsId: string) {
    if (busy || latestOptions?.turn.options?.options_id !== optionsId) return;
    setOpeningView(optionsId);
    setViewFailure(null);
    try {
      const props = await createHomeownerView(applicationId, optionsId);
      navigate(homeownerPath(applicationId), { state: props });
    } catch (error) {
      setViewFailure({ optionsId, message: toErrorBody(error).message });
    } finally {
      setOpeningView(null);
    }
  }

  const lastExchange = exchanges[exchanges.length - 1];

  return (
    <section className="copilot-card" aria-labelledby="copilot-title">
      <div className="card-head">
        <span className="assistant-mark" aria-hidden="true">
          <SparkleIcon />
        </span>
        <h2 id="copilot-title">Assistant</h2>
      </div>

      <div className="transcript" ref={transcriptRef} role="log" aria-label="Conversation">
        {exchanges.length === 0 && assistantAvailable ? (
          <div className="onboarding">
            <p>Ask about financing for this project.</p>
            <div className="prompt-list">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button key={prompt} type="button" className="prompt-chip" onClick={() => send(prompt)}>
                  {prompt}
                  <ChevronRightIcon />
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {exchanges.map((exchange) => (
          <ExchangeView
            key={exchange.id}
            exchange={exchange}
            applicationId={applicationId}
            highlighted={highlighted === exchange.id}
            canRetry={!busy && exchange === lastExchange}
            canOpenView={!busy && exchange === latestOptions}
            isLatestOptions={exchange === latestOptions}
            openingView={openingView}
            viewFailure={viewFailure}
            onRetry={() => void conversationStore.retry(applicationId, exchange.id)}
            onOpenView={(optionsId) => void openHomeownerView(optionsId)}
          />
        ))}
      </div>

      <div className="calculator-bar">
        <button
          type="button"
          className="button"
          disabled={!amountReady || busy}
          onClick={() => void conversationStore.showPaymentOptions(applicationId)}
        >
          Show payment options
        </button>
        {!amountReady ? <span className="calculator-caption">{NO_MODEL_CAPTION}</span> : null}
      </div>

      {!assistantAvailable ? (
        <p className="panel-notice" role="status">
          {disabledByOperator ? COPILOT_DISABLED_MESSAGE : keyProblem}
        </p>
      ) : null}

      <form className="composer" onSubmit={onSubmit}>
        <label htmlFor="composer-input" className="sr-only">
          Message the assistant
        </label>
        <textarea
          id="composer-input"
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          value={draft}
          disabled={!assistantAvailable}
          placeholder={assistantAvailable ? "Message the assistant" : "The assistant is unavailable"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="send-button"
          aria-label="Send"
          disabled={!assistantAvailable || busy || draft.trim() === ""}
        >
          <ArrowUpIcon />
        </button>
      </form>
    </section>
  );
}

function bubbleId(exchangeId: string): string {
  return `chat-${exchangeId}`;
}

interface ExchangeViewProps {
  exchange: Exchange;
  applicationId: string;
  highlighted: boolean;
  canRetry: boolean;
  /** This exchange holds the newest options table and no reply is running. */
  canOpenView: boolean;
  /** This exchange holds the newest options table. */
  isLatestOptions: boolean;
  openingView: string | null;
  viewFailure: { optionsId: string; message: string } | null;
  onRetry(): void;
  onOpenView(optionsId: string): void;
}

function ExchangeView({
  exchange,
  applicationId,
  highlighted,
  canRetry,
  canOpenView,
  isLatestOptions,
  openingView,
  viewFailure,
  onRetry,
  onOpenView,
}: ExchangeViewProps) {
  return (
    <div className="exchange">
      {exchange.text !== null ? (
        <div id={bubbleId(exchange.id)} className={`bubble contractor${highlighted ? " highlighted" : ""}`}>
          {exchange.text}
        </div>
      ) : null}
      {turnHasContent(exchange.turn) ? (
        <div className="bubble assistant">
          <TurnView
            turn={exchange.turn}
            applicationId={applicationId}
            canRetry={canRetry}
            canOpenView={canOpenView}
            isLatestOptions={isLatestOptions}
            openingView={openingView}
            viewFailure={viewFailure}
            onRetry={onRetry}
            onOpenView={onOpenView}
          />
        </div>
      ) : null}
      {exchange.turn.explanation?.question ? (
        <div className="bubble assistant question">
          <p className="reply-text">{exchange.turn.explanation.question}</p>
        </div>
      ) : null}
    </div>
  );
}

interface TurnViewProps {
  turn: TurnState;
  applicationId: string;
  canRetry: boolean;
  canOpenView: boolean;
  isLatestOptions: boolean;
  openingView: string | null;
  viewFailure: { optionsId: string; message: string } | null;
  onRetry(): void;
  onOpenView(optionsId: string): void;
}

/** One assistant reply: options, proposals note, explanation or fallback, error, and the status line. */
function TurnView({
  turn,
  applicationId,
  canRetry,
  canOpenView,
  isLatestOptions,
  openingView,
  viewFailure,
  onRetry,
  onOpenView,
}: TurnViewProps) {
  const options = turn.options;
  const proposalCount = turn.proposals?.ids.length ?? 0;
  return (
    <>
      {options ? (
        <>
          <OptionsTable
            line={options}
            actions={
              <>
                <button
                  type="button"
                  className="button primary small"
                  disabled={!canOpenView || openingView !== null}
                  onClick={() => onOpenView(options.options_id)}
                >
                  Show homeowner view
                </button>
                {!isLatestOptions ? <span className="options-caption">{OLDER_OPTIONS_CAPTION}</span> : null}
              </>
            }
          />
          {viewFailure?.optionsId === options.options_id ? (
            <p className="field-error" role="alert">
              {viewFailure.message}
            </p>
          ) : null}
        </>
      ) : null}
      {proposalCount > 0 ? <p className="reply-note">{proposalCountText(proposalCount)}</p> : null}
      {turn.proposals?.note ? <p className="reply-note">{turn.proposals.note}</p> : null}
      {turn.explanation ? (
        <>
          <p className="reply-text">{turn.explanation.text}</p>
          {turn.explanation.footer ? <p className="reply-footer">{turn.explanation.footer}</p> : null}
        </>
      ) : null}
      {turn.fallback ? (
        <>
          <p className="reply-text">{turn.fallback.text}</p>
          <p className="fallback-marker">
            <Link to={auditPath(applicationId, turn.fallback.audit_event_id)}>{turn.fallback.marker}</Link>
          </p>
        </>
      ) : null}
      {turn.error ? (
        <div className="reply-error" role="alert">
          <p>{turn.error.message}</p>
          {turn.error.retryable && canRetry ? (
            <button type="button" className="button small" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {turn.phase === "running" && turn.status ? (
        <p className="status-line" role="status">
          {turn.status}
        </p>
      ) : null}
    </>
  );
}
