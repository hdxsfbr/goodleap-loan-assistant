import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  canConfirm,
  canCorrect,
  canFlag,
  confirmRequest,
  correctionStartText,
  decisionSummary,
  defaultFlagReason,
  enumOptionLabel,
  formatDiscrepancyValue,
  formatRowValue,
  groupRows,
  hasAction,
  LOCATION_LABELS,
  sourceClaim,
  STATUS_LABELS,
  waitingFor,
  type CompleteState,
} from "../review-present";
import type { DerivedInputView, ReviewDecision, TaskDocumentView, TaskFieldRow, TaskView } from "../review-types";

// One row per schema field of the document: the value, where it was read, and what the reviewer
// can do with it. Nothing here changes a value on its own: Confirm, Correct and Flag each send a
// decision and wait for the refreshed task.

export interface ValueListProps {
  doc: TaskDocumentView;
  texts: TaskView["texts"];
  selectedKey: string | null;
  onSelect(fieldKey: string): void;
  /** Sends one decision. Resolves true when the server accepted it; the message of a refusal is in `errors`. */
  onDecide(row: TaskFieldRow, request: ReviewDecision): Promise<boolean>;
  /** True while a write is in flight; every control waits. */
  busy: boolean;
  /** The server's message for the last refused decision, by field key. */
  errors: Readonly<Record<string, string>>;
  /** Drops a row's message when the reviewer starts over or backs out. */
  onClearError(fieldKey: string): void;
  complete: CompleteState;
  onComplete(): void;
  completeError: string | null;
}

const INPUT_STATE_LABELS: Readonly<Record<string, string>> = {
  proposed: "To decide",
  confirmed: "Confirmed",
  edited: "Corrected",
  rejected: "Flagged",
  superseded: "Replaced",
};

function statusBadgeClass(row: TaskFieldRow): string {
  switch (row.status) {
    case "undecided":
      return "badge-proposed";
    case "confirmed":
      return "badge-confirmed";
    case "edited":
      return "badge-edited";
    case "flagged":
      return "badge-flagged";
    case "waiting":
      return "badge-empty";
  }
}

function locationBadgeClass(row: TaskFieldRow): string {
  switch (row.location) {
    case "located":
      return "badge-located";
    case "not_located":
      return "badge-not-located";
    case "derived":
      return "badge-typed";
    case "not_extracted":
      return "badge-empty";
  }
}

export function ValueList({
  doc,
  texts,
  selectedKey,
  onSelect,
  onDecide,
  busy,
  errors,
  onClearError,
  complete,
  onComplete,
  completeError,
}: ValueListProps) {
  const groups = groupRows(doc.rows);
  return (
    <section className="value-list" aria-label={`${doc.title}, values`}>
      {doc.flag ? (
        <p className="notice" role="note">
          {doc.flag.text}
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group.id} className="value-group">
          {group.title ? <h3 className="value-group-title">{group.title}</h3> : null}
          <ul className="value-rows">
            {group.rows.map((row) => (
              <ValueRow
                key={`${row.field_key}:${row.proposal?.id ?? "none"}`}
                row={row}
                doc={doc}
                texts={texts}
                selected={row.field_key === selectedKey}
                onSelect={onSelect}
                onDecide={onDecide}
                busy={busy}
                error={errors[row.field_key] ?? null}
                onClearError={onClearError}
              />
            ))}
          </ul>
        </div>
      ))}

      <div className="complete-bar">
        <button type="button" className="button primary" disabled={!complete.enabled || busy} onClick={onComplete}>
          Complete review
        </button>
        <span className="complete-caption">{complete.caption}</span>
        {completeError ? (
          <p className="field-error" role="alert">
            {completeError}
          </p>
        ) : null}
      </div>
    </section>
  );
}

interface ValueRowProps {
  row: TaskFieldRow;
  doc: TaskDocumentView;
  texts: TaskView["texts"];
  selected: boolean;
  onSelect(fieldKey: string): void;
  onDecide(row: TaskFieldRow, request: ReviewDecision): Promise<boolean>;
  busy: boolean;
  error: string | null;
  onClearError(fieldKey: string): void;
}

type Mode = "idle" | "correct" | "flag";

function ValueRow({ row, doc, texts, selected, onSelect, onDecide, busy, error, onClearError }: ValueRowProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [acknowledged, setAcknowledged] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const ackId = useId();
  const claim = sourceClaim(row);
  const value = row.proposal?.value ?? null;
  const summary = decisionSummary(row, texts.flag_reasons);
  const waiting = waitingFor(row);

  // A pick made on the page brings its row into view.
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  function open(next: Mode) {
    onClearError(row.field_key);
    setMode(next);
  }

  async function run(request: ReviewDecision): Promise<boolean> {
    const ok = await onDecide(row, request);
    if (ok) setMode("idle");
    return ok;
  }

  let display: string;
  let displayClass = "value-text";
  if (value !== null) {
    display = formatRowValue(row.type, value);
  } else if (row.location === "derived") {
    display = row.status === "waiting" ? "Not calculated yet" : "Not calculated";
    displayClass += " is-empty";
  } else {
    display = "No value found";
    displayClass += " is-empty";
  }

  return (
    <li
      ref={rowRef}
      className={`value-row status-${row.status}${selected ? " selected" : ""}`}
      data-field={row.field_key}
      data-status={row.status}
      data-location={row.location}
    >
      <button type="button" className="value-main" onClick={() => onSelect(row.field_key)} aria-pressed={selected}>
        <span className="value-label">{row.label}</span>
        <span className="value-badges">
          <span className={`badge ${statusBadgeClass(row)}`}>{STATUS_LABELS[row.status]}</span>
          <span className={`badge ${locationBadgeClass(row)}`}>{LOCATION_LABELS[row.location]}</span>
        </span>
        <span className={displayClass}>{display}</span>
      </button>

      <div className="value-body">
        {claim && claim.quote && row.location !== "not_extracted" ? (
          <p className="value-quote">
            {claim.page === null ? "Quoted: " : `Page ${claim.page}: `}
            <q>{claim.quote}</q>
          </p>
        ) : null}

        {row.location === "not_located" && row.status === "undecided" ? (
          <div className="value-not-located">
            <p>{texts.not_located_caption}</p>
            {claim && claim.page !== null ? <p className="muted">The model claimed page {claim.page}.</p> : null}
            {row.requires_acknowledgement ? (
              <label className="value-ack" htmlFor={ackId}>
                <input
                  id={ackId}
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>{texts.located_acknowledgement}</span>
              </label>
            ) : null}
          </div>
        ) : null}

        {row.compare_to ? (
          <p className="value-compare">
            {row.compare_to.label} on the application: {formatDiscrepancyValue(row.compare_to.stated_value)}
          </p>
        ) : null}

        {row.formula ? (
          <div className="formula">
            <p className="formula-text">{row.description}</p>
            <ul className="formula-inputs">
              {row.formula.inputs.map((input) => (
                <FormulaInput key={input.field_key} input={input} doc={doc} onSelect={onSelect} />
              ))}
            </ul>
            {row.status === "waiting" && waiting.length > 0 ? (
              <p className="muted">Waiting for a decision on: {waiting.join(", ")}.</p>
            ) : null}
          </div>
        ) : null}

        {summary ? <p className="value-summary">{summary}</p> : null}

        {row.actions.length > 0 && mode === "idle" ? (
          <div className="value-actions">
            {hasAction(row, "confirm") ? (
              <button
                type="button"
                className="button small primary"
                disabled={busy || !canConfirm(row, acknowledged)}
                onClick={() => void run(confirmRequest(row))}
              >
                Confirm
              </button>
            ) : null}
            {hasAction(row, "correct") ? (
              <button type="button" className="button small" disabled={busy} onClick={() => open("correct")}>
                Correct
              </button>
            ) : null}
            {hasAction(row, "flag") ? (
              <button type="button" className="button small" disabled={busy} onClick={() => open("flag")}>
                Flag
              </button>
            ) : null}
          </div>
        ) : null}

        {mode === "correct" ? (
          <CorrectForm row={row} busy={busy} onSubmit={(text) => run({ action: "correct", value: text })} onCancel={() => open("idle")} />
        ) : null}
        {mode === "flag" ? (
          <FlagForm row={row} texts={texts} busy={busy} onSubmit={(request) => run(request)} onCancel={() => open("idle")} />
        ) : null}

        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function FormulaInput({
  input,
  doc,
  onSelect,
}: {
  input: DerivedInputView;
  doc: TaskDocumentView;
  onSelect(fieldKey: string): void;
}) {
  const type = doc.rows.find((candidate) => candidate.field_key === input.field_key)?.type ?? "text";
  const state = input.state === null ? "No value" : (INPUT_STATE_LABELS[input.state] ?? input.state);
  return (
    <li>
      <button type="button" className="link-button" onClick={() => onSelect(input.field_key)}>
        {input.label}
      </button>
      <span className="formula-value">{input.value === null ? "No value" : formatRowValue(type, input.value)}</span>
      <span className="muted">{state}</span>
    </li>
  );
}

function CorrectForm({
  row,
  busy,
  onSubmit,
  onCancel,
}: {
  row: TaskFieldRow;
  busy: boolean;
  onSubmit(text: string): Promise<boolean>;
  onCancel(): void;
}) {
  const inputId = useId();
  const start = correctionStartText(row.type, row.proposal?.value ?? null);
  const [text, setText] = useState(start);
  const options = row.type === "enum" ? row.options : null;
  const long = row.type === "text" && start.length > 60;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (canCorrect(row, text)) await onSubmit(text.trim());
  }

  return (
    <form className="value-form" onSubmit={(event) => void submit(event)}>
      <label className="label" htmlFor={inputId}>
        {row.proposal?.value === null ? `${row.label} as written on the page` : `Correct ${row.label.toLowerCase()}`}
      </label>
      {options ? (
        <select id={inputId} value={text} disabled={busy} onChange={(event) => setText(event.target.value)}>
          <option value="">Choose a value</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {enumOptionLabel(option)}
            </option>
          ))}
        </select>
      ) : long ? (
        <textarea id={inputId} rows={3} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
      ) : (
        <input
          id={inputId}
          type="text"
          value={text}
          disabled={busy}
          autoFocus
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <div className="value-actions">
        <button type="submit" className="button small primary" disabled={busy || !canCorrect(row, text)}>
          Save correction
        </button>
        <button type="button" className="button small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function FlagForm({
  row,
  texts,
  busy,
  onSubmit,
  onCancel,
}: {
  row: TaskFieldRow;
  texts: TaskView["texts"];
  busy: boolean;
  onSubmit(request: ReviewDecision): Promise<boolean>;
  onCancel(): void;
}) {
  const reasonId = useId();
  const noteId = useId();
  const [reason, setReason] = useState(defaultFlagReason(row));
  const [note, setNote] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canFlag(row, reason)) return;
    const request: ReviewDecision = {
      action: "flag",
      reason_code: reason as NonNullable<ReviewDecision["reason_code"]>,
      ...(note.trim() === "" ? {} : { note: note.trim() }),
    };
    await onSubmit(request);
  }

  return (
    <form className="value-form" onSubmit={(event) => void submit(event)}>
      <label className="label" htmlFor={reasonId}>
        Reason
      </label>
      <select id={reasonId} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)}>
        <option value="">Choose a reason</option>
        {Object.entries(texts.flag_reasons).map(([code, label]) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </select>
      <label className="label" htmlFor={noteId}>
        Note (optional)
      </label>
      <input id={noteId} type="text" value={note} disabled={busy} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      <div className="value-actions">
        <button type="submit" className="button small primary" disabled={busy || !canFlag(row, reason)}>
          Flag this value
        </button>
        <button type="button" className="button small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
