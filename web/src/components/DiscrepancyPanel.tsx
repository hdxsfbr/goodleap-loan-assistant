import { useId, useState, type FormEvent } from "react";
import type { DiscrepancyResolution } from "@shared/schemas";
import {
  discrepancyStage,
  findRowForRecord,
  formatDifference,
  formatDiscrepancyValue,
  formatWhen,
  RESOLUTION_HINTS,
  RESOLUTION_LABELS,
  sourceClaim,
} from "../review-present";
import type { TaskDiscrepancyView, TaskView } from "../review-types";

// Each record the review opened: the application's value beside the document's, the rule that was
// broken, the question for the contractor (the template for the reason, which the reviewer may edit
// before sending), the contractor's reply, and the reviewer's resolution. The difference shown is
// the one the record stored when the rule ran.

export interface DiscrepancyPanelProps {
  view: TaskView;
  busy: boolean;
  /** The server's message for the last refused write, by record id. */
  errors: Readonly<Record<string, string>>;
  /** Sends the question. Resolves true when the server accepted it. */
  onSend(recordId: string, text: string): Promise<boolean>;
  onResolve(recordId: string, resolution: DiscrepancyResolution, note: string): Promise<boolean>;
  /** Selects the value a record was raised on, in its document's tab. */
  onShowValue(documentId: string, fieldKey: string): void;
}

const STAGE_LABELS = {
  draft: "Not sent",
  sent: "Waiting for a reply",
  replied: "Reply received",
  resolved: "Resolved",
} as const;

const STAGE_BADGES = {
  draft: "badge-proposed",
  sent: "badge-typed",
  replied: "badge-edited",
  resolved: "badge-confirmed",
} as const;

export function DiscrepancyPanel({ view, busy, errors, onSend, onResolve, onShowValue }: DiscrepancyPanelProps) {
  if (view.discrepancies.length === 0) return null;
  // Open records first, in the order they were raised.
  const ordered = [...view.discrepancies].sort(
    (a, b) => Number(a.record.status === "resolved") - Number(b.record.status === "resolved"),
  );
  return (
    <section className="discrepancies" id="differences" aria-labelledby="differences-title">
      <h2 id="differences-title" className="section-title">
        Differences with the application
      </h2>
      <div className="discrepancy-list">
        {ordered.map((item) => (
          <DiscrepancyCard
            key={item.record.id}
            item={item}
            view={view}
            busy={busy}
            error={errors[item.record.id] ?? null}
            onSend={onSend}
            onResolve={onResolve}
            onShowValue={onShowValue}
          />
        ))}
      </div>
    </section>
  );
}

interface CardProps {
  item: TaskDiscrepancyView;
  view: TaskView;
  busy: boolean;
  error: string | null;
  onSend(recordId: string, text: string): Promise<boolean>;
  onResolve(recordId: string, resolution: DiscrepancyResolution, note: string): Promise<boolean>;
  onShowValue(documentId: string, fieldKey: string): void;
}

function DiscrepancyCard({ item, view, busy, error, onSend, onResolve, onShowValue }: CardProps) {
  const { record } = item;
  const stage = discrepancyStage(record);
  const found = findRowForRecord(view, record);
  const claim = found ? sourceClaim(found.row) : null;
  const inputs = found?.row.formula?.inputs.map((input) => input.label) ?? [];

  const extractedHow = found?.row.formula
    ? `Calculated from ${inputs.join(" and ").toLowerCase()}`
    : claim?.page
      ? `Read from page ${claim.page}`
      : "Read from the document";

  return (
    <article className="discrepancy" data-record={record.id} data-stage={stage}>
      <header className="discrepancy-head">
        <h3>{item.field_label} differs from the application</h3>
        <span className={`badge ${STAGE_BADGES[stage]}`}>{STAGE_LABELS[stage]}</span>
      </header>

      <div className="discrepancy-values">
        <div className="discrepancy-side">
          <p className="label">{item.stated_label}</p>
          <p className="discrepancy-figure">{formatDiscrepancyValue(record.stated.value)}</p>
          <p className="muted">
            {record.stated.pointer.kind === "form" ? "Entered on the application" : "Read from a document"}
          </p>
        </div>
        <div className="discrepancy-side">
          <p className="label">
            {item.field_label}
            {found ? ` · ${found.document.title}` : ""}
          </p>
          <p className="discrepancy-figure">{formatDiscrepancyValue(record.extracted.value)}</p>
          <p className="muted">
            {extractedHow}
            {found ? (
              <>
                {" · "}
                <button type="button" className="link-button" onClick={() => onShowValue(found.document.id, found.row.field_key)}>
                  Show in the list
                </button>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <p className="discrepancy-diff">
        <strong>Difference:</strong> {formatDifference(record.difference)}
      </p>
      {item.rule_text ? (
        <p className="discrepancy-rule">
          <strong>Rule:</strong> {item.rule_text}
        </p>
      ) : null}

      {stage === "draft" ? (
        <QuestionEditor record={record} busy={busy} onSend={onSend} />
      ) : (
        <div className="discrepancy-thread">
          <p className="label">
            Question sent{record.sent_at ? ` · ${formatWhen(record.sent_at)}` : ""}
          </p>
          <blockquote className="thread-question">{record.question.text}</blockquote>
          {record.contractor_reply ? (
            <>
              <p className="label">Contractor's reply · {formatWhen(record.contractor_reply.at)}</p>
              <blockquote className="thread-reply">{record.contractor_reply.text}</blockquote>
            </>
          ) : stage === "sent" ? (
            <p className="muted">Waiting for the contractor's reply.</p>
          ) : null}
        </div>
      )}

      {stage === "sent" || stage === "replied" ? <ResolveForm recordId={record.id} busy={busy} onResolve={onResolve} /> : null}

      {stage === "resolved" ? (
        <div className="discrepancy-resolution">
          <p className="label">
            Resolved as {record.resolution ? RESOLUTION_LABELS[record.resolution].toLowerCase() : "resolved"}
          </p>
          {record.note ? <p>{record.note}</p> : null}
        </div>
      ) : null}

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function QuestionEditor({
  record,
  busy,
  onSend,
}: {
  record: TaskDiscrepancyView["record"];
  busy: boolean;
  onSend(recordId: string, text: string): Promise<boolean>;
}) {
  const id = useId();
  const [text, setText] = useState(record.question.text);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (text.trim() !== "") await onSend(record.id, text.trim());
  }

  return (
    <form className="discrepancy-question" onSubmit={(event) => void submit(event)}>
      <label className="label" htmlFor={id}>
        Question for the contractor
      </label>
      <textarea id={id} rows={4} maxLength={4000} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
      <div className="value-actions">
        <button type="submit" className="button primary" disabled={busy || text.trim() === ""}>
          Send to the contractor
        </button>
        <span className="muted">You can edit the question before it is sent.</span>
      </div>
    </form>
  );
}

function ResolveForm({
  recordId,
  busy,
  onResolve,
}: {
  recordId: string;
  busy: boolean;
  onResolve(recordId: string, resolution: DiscrepancyResolution, note: string): Promise<boolean>;
}) {
  const selectId = useId();
  const noteId = useId();
  const [resolution, setResolution] = useState<DiscrepancyResolution>("explained");
  const [note, setNote] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (note.trim() !== "") await onResolve(recordId, resolution, note.trim());
  }

  return (
    <form className="discrepancy-resolve" onSubmit={(event) => void submit(event)}>
      <label className="label" htmlFor={selectId}>
        Resolve as
      </label>
      <select
        id={selectId}
        value={resolution}
        disabled={busy}
        onChange={(event) => setResolution(event.target.value as DiscrepancyResolution)}
      >
        {(Object.keys(RESOLUTION_LABELS) as DiscrepancyResolution[]).map((option) => (
          <option key={option} value={option}>
            {RESOLUTION_LABELS[option]}
          </option>
        ))}
      </select>
      <p className="muted">{RESOLUTION_HINTS[resolution]}</p>
      <label className="label" htmlFor={noteId}>
        Note
      </label>
      <textarea id={noteId} rows={2} maxLength={4000} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
      <div className="value-actions">
        <button type="submit" className="button" disabled={busy || note.trim() === ""}>
          Resolve
        </button>
      </div>
    </form>
  );
}
