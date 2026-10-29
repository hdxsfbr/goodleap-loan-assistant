import { useEffect, useState } from "react";
import { APPLICATION_FIELDS, type ApplicationFieldDef } from "@shared/application-schema";
import { parseMoney } from "@shared/format";
import type { ApplicationFieldView, ApplicationView, FieldValue } from "@shared/schemas";
import { toErrorBody } from "../errors";
import {
  BADGE_LABELS,
  badgeCaption,
  enumLabel,
  fieldDisplayValue,
  fieldInputText,
  proposalMessageId,
  proposalQuote,
  type FieldBadge,
} from "../present";
import { createLockSet } from "../sync";

/** The writes the form can make. Each rejects with an `ApiError` the form shows beside the field. */
export interface FormActions {
  setField(fieldKey: string, value: string): Promise<void>;
  confirm(proposalId: string): Promise<void>;
  reject(proposalId: string): Promise<void>;
  edit(proposalId: string, value: string): Promise<void>;
  confirmAll(): Promise<void>;
}

interface ApplicationFormProps {
  view: ApplicationView;
  actions: FormActions;
  /** True when the chat on this page holds the contractor message a proposal came from. */
  canShowSource(messageId: string): boolean;
  /** Scroll the chat to the message a proposal came from and highlight it. */
  onShowSource(messageId: string): void;
}

function badgeOf(field: ApplicationFieldView | undefined): FieldBadge {
  return field ? field.state : "empty";
}

/** Runs a request that holds these proposals; false (and does nothing) when any is already held. */
type HoldProposals = (ids: readonly string[], work: () => Promise<void>) => Promise<boolean>;

function proposalIdsOf(view: ApplicationView): string[] {
  const ids: string[] = [];
  for (const field of Object.values(view.fields)) {
    if (field.state === "proposed" && field.proposal_id !== null) ids.push(field.proposal_id);
  }
  return ids;
}

/** The application, rendered from the field schema. */
export function ApplicationForm({ view, actions, canShowSource, onShowSource }: ApplicationFormProps) {
  const locked = view.status !== "draft";
  const pending = Object.values(view.fields).filter((field) => field.state === "proposed").length;
  const proposalIds = proposalIdsOf(view);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // One request at a time per proposal, whether it comes from its own buttons or from Confirm all.
  const [locks] = useState(createLockSet);
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());

  const hold: HoldProposals = async (ids, work) => {
    if (!locks.acquire(ids)) return false;
    setHeld(locks.snapshot());
    try {
      await work();
    } finally {
      locks.release(ids);
      setHeld(locks.snapshot());
    }
    return true;
  };

  async function confirmAll() {
    setBulkError(null);
    await hold(proposalIds, async () => {
      try {
        await actions.confirmAll();
      } catch (error) {
        setBulkError(toErrorBody(error).message);
      }
    });
  }

  const anyHeld = proposalIds.some((id) => held.has(id));

  return (
    <section className="form-card" aria-labelledby="form-title">
      <div className="card-head">
        <h2 id="form-title">Application</h2>
        {pending > 0 && !locked ? (
          <button type="button" className="button primary small" onClick={() => void confirmAll()} disabled={anyHeld}>
            Confirm all ({pending})
          </button>
        ) : null}
      </div>
      {bulkError ? (
        <p className="field-error" role="alert">
          {bulkError}
        </p>
      ) : null}
      <div className="field-grid">
        {APPLICATION_FIELDS.map((def) => (
          <FieldRow
            key={def.id}
            def={def}
            field={view.fields[def.id]}
            locked={locked}
            actions={actions}
            held={held}
            hold={hold}
            canShowSource={canShowSource}
            onShowSource={onShowSource}
          />
        ))}
      </div>
    </section>
  );
}

interface FieldRowProps {
  def: ApplicationFieldDef;
  field: ApplicationFieldView | undefined;
  locked: boolean;
  actions: FormActions;
  held: ReadonlySet<string>;
  hold: HoldProposals;
  canShowSource(messageId: string): boolean;
  onShowSource(messageId: string): void;
}

function FieldRow({ def, field, locked, actions, held, hold, canShowSource, onShowSource }: FieldRowProps) {
  const [error, setError] = useState<string | null>(null);
  const badge = badgeOf(field);
  const inputId = `field-${def.id}`;

  async function attempt(work: () => Promise<void>): Promise<boolean> {
    setError(null);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(toErrorBody(caught).message);
      return false;
    }
  }

  // The quote comes with the proposal, so it shows after a reload; only the jump needs the chat.
  const messageId = field ? proposalMessageId(field) : null;
  const quote = field ? proposalQuote(field) : null;
  const badgeNode =
    badge === "proposed" && messageId !== null && canShowSource(messageId) ? (
      <button
        type="button"
        className={`badge badge-proposed badge-button`}
        onClick={() => onShowSource(messageId)}
        title="Show the message this came from"
      >
        {BADGE_LABELS.proposed}
      </button>
    ) : (
      <span className={`badge badge-${badge}`}>{BADGE_LABELS[badge]}</span>
    );

  return (
    <div className={`field-row${badge === "proposed" ? " has-proposal" : ""}`}>
      <div className="field-head">
        <label htmlFor={inputId}>{def.label}</label>
        {badgeNode}
      </div>
      {field && field.state === "proposed" ? (
        <ProposalCard
          def={def}
          field={field}
          inputId={inputId}
          quote={quote}
          locked={locked}
          actions={actions}
          held={held}
          hold={hold}
          attempt={attempt}
        />
      ) : (
        <FieldInput
          def={def}
          id={inputId}
          value={field ? field.value : null}
          disabled={locked}
          onCommit={(text) => attempt(() => actions.setField(def.id, text))}
        />
      )}
      <p className="field-caption">{badgeCaption(badge, def.required)}</p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface FieldInputProps {
  def: ApplicationFieldDef;
  id: string;
  value: FieldValue | null;
  disabled: boolean;
  /** Called with the entered text; resolves false when the save failed. */
  onCommit(text: string): Promise<boolean>;
}

/** One input for a typed value. Saves on blur or Enter (text) or on change (a choice). */
function FieldInput({ def, id, value, disabled, onCommit }: FieldInputProps) {
  const shown = value === null ? "" : fieldInputText(def.id, value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => {
    setDraft(shown);
  }, [shown]);

  async function commit(text: string) {
    const trimmed = text.trim();
    // "30000" and "$30,000.00" are the same amount; saving it again would only add noise to the audit trail.
    const unchanged = def.type === "money" && value !== null ? parseMoney(trimmed) === value : trimmed === shown;
    if (trimmed === "" || unchanged) {
      setDraft(shown);
      return;
    }
    await onCommit(trimmed);
  }

  if (def.type === "enum") {
    return (
      <select
        id={id}
        value={shown}
        disabled={disabled}
        onChange={(event) => void commit(event.target.value)}
      >
        {shown === "" ? <option value="">Select...</option> : null}
        {(def.options ?? []).map((option) => (
          <option key={option} value={option}>
            {enumLabel(def.id, option)}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={id}
      type="text"
      inputMode={def.type === "money" ? "decimal" : def.type === "zip" ? "numeric" : "text"}
      autoComplete="off"
      value={draft}
      disabled={disabled}
      placeholder={def.type === "money" ? "$0.00" : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

interface ProposalCardProps {
  def: ApplicationFieldDef;
  field: ApplicationFieldView;
  inputId: string;
  quote: string | null;
  locked: boolean;
  actions: FormActions;
  held: ReadonlySet<string>;
  hold: HoldProposals;
  attempt(work: () => Promise<void>): Promise<boolean>;
}

/** A proposed value on its field: old to new, the message it came from, Confirm, Edit and Reject. */
function ProposalCard({ def, field, inputId, quote, locked, actions, held, hold, attempt }: ProposalCardProps) {
  const [editing, setEditing] = useState(false);
  const proposalId = field.proposal_id;
  const proposedText = fieldInputText(def.id, field.value);
  const [draft, setDraft] = useState(proposedText);
  useEffect(() => {
    setDraft(proposedText);
  }, [proposedText]);

  if (proposalId === null) return null;

  const busy = held.has(proposalId);

  async function run(work: () => Promise<void>) {
    if (proposalId === null) return;
    await hold([proposalId], () => attempt(work).then(() => undefined));
  }

  const old = field.previous ? fieldDisplayValue(def.id, field.previous.value) : "empty";

  return (
    <div className="proposal-card">
      <p className="proposal-change">
        <span className={field.previous ? "proposal-old" : "proposal-old is-empty"}>{old}</span>
        <span aria-hidden="true"> → </span>
        <span className="sr-only"> changes to </span>
        <strong className="proposal-new">{fieldDisplayValue(def.id, field.value)}</strong>
      </p>
      {quote ? <blockquote className="proposal-quote">{quote}</blockquote> : null}
      {editing ? (
        <div className="proposal-edit">
          {def.type === "enum" ? (
            <select id={inputId} value={draft} onChange={(event) => setDraft(event.target.value)}>
              {(def.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {enumLabel(def.id, option)}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={inputId}
              type="text"
              value={draft}
              autoComplete="off"
              inputMode={def.type === "money" ? "decimal" : def.type === "zip" ? "numeric" : "text"}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          <div className="proposal-actions">
            <button
              type="button"
              className="button primary small"
              disabled={busy || draft.trim() === ""}
              onClick={() =>
                void run(async () => {
                  await actions.edit(proposalId, draft.trim());
                  setEditing(false);
                })
              }
            >
              Save
            </button>
            <button type="button" className="button small" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="proposal-actions">
          <button
            type="button"
            className="button primary small"
            disabled={busy || locked}
            onClick={() => void run(() => actions.confirm(proposalId))}
          >
            Confirm
          </button>
          <button type="button" className="button small" disabled={busy || locked} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className="button small"
            disabled={busy || locked}
            onClick={() => void run(() => actions.reject(proposalId))}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
