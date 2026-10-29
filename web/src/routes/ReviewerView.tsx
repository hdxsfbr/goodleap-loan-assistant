import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { DiscrepancyResolution } from "@shared/schemas";
import { DiscrepancyPanel } from "../components/DiscrepancyPanel";
import { DocumentViewer } from "../components/DocumentViewer";
import { ChevronRightIcon, DocumentIcon } from "../components/Icons";
import { ValueList } from "../components/ValueList";
import { toErrorBody } from "../errors";
import {
  completeReview,
  decide,
  getTask,
  listTasks,
  notifyReviewTasksChanged,
  resolveDiscrepancy,
  sendQuestion,
} from "../review-api";
import {
  awaitsReply,
  completeState,
  firstSelectable,
  formatWhen,
  nextUndecidedKey,
  openDiscrepancyCount,
  reviewTaskPath,
  tabCaption,
  TASK_STATUS_LABELS,
} from "../review-present";
import type { ReviewDecision, TaskFieldRow, TaskList, TaskView } from "../review-types";

/** How often a task waiting for the contractor's reply is looked at again. */
const REPLY_POLL_MS = 5000;

/** The reviewer tab: the task list at `/reviewer`, one task at `/reviewer/:taskId`. */
export function ReviewerView() {
  const { taskId } = useParams();
  return taskId ? <TaskPage key={taskId} taskId={taskId} /> : <TaskListPage />;
}

function taskBadgeClass(status: TaskView["task"]["status"]): string {
  switch (status) {
    case "complete":
      return "badge-confirmed";
    case "in_review":
      return "badge-edited";
    case "extraction_failed":
      return "badge-flagged";
    case "ready":
      return "badge-proposed";
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------------------------
// The task list
// ---------------------------------------------------------------------------------------------

function TaskListPage() {
  const [list, setList] = useState<TaskList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await listTasks());
      setError(null);
    } catch (caught) {
      setError(toErrorBody(caught).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  return (
    <div className="page reviewer-page">
      <div className="page-head">
        <h1 className="page-title">Documents to review</h1>
        <button type="button" className="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {list ? (
        list.tasks.length === 0 ? (
          <p className="muted">No documents are waiting for review.</p>
        ) : (
          <ul className="task-list">
            {list.tasks.map((task) => (
              <li key={task.id} className="task-card">
                <span className="card-icon">
                  <DocumentIcon />
                </span>
                <div className="task-card-main">
                  <h2 className="task-card-title">
                    <Link to={reviewTaskPath(task.id)}>Application {task.application_id}</Link>
                  </h2>
                  <p className="muted">
                    {plural(task.document_count, "document", "documents")} ·{" "}
                    {plural(task.undecided_count, "value to decide", "values to decide")} ·{" "}
                    {plural(task.open_discrepancies, "open difference", "open differences")}
                  </p>
                  <p className="muted">
                    Ticket {task.jsm_issue_id} · opened {formatWhen(task.created_at)}
                  </p>
                </div>
                <span className={`badge ${taskBadgeClass(task.status)}`}>{TASK_STATUS_LABELS[task.status]}</span>
                <Link to={reviewTaskPath(task.id)} className="button primary small">
                  {task.status === "complete" ? "View" : "Review"}
                </Link>
                <ChevronRightIcon className="card-chevron" />
              </li>
            ))}
          </ul>
        )
      ) : loading ? (
        <p className="muted">Loading...</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One task
// ---------------------------------------------------------------------------------------------

interface Selection {
  key: string | null;
  /** Bumped by every pick, so the viewer returns to the page even when the same value is picked again. */
  nonce: number;
}

function TaskPage({ taskId }: { taskId: string }) {
  const [view, setView] = useState<TaskView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ key: null, nonce: 0 });
  const [busy, setBusy] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [recordErrors, setRecordErrors] = useState<Record<string, string>>({});
  const [completeError, setCompleteError] = useState<string | null>(null);
  // Responses can arrive out of order; only the newest request may set the view.
  const latest = useRef(0);
  const busyRef = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const next = await getTask(taskId);
      if (ticket === latest.current) {
        setView(next);
        setLoadError(null);
      }
    } catch (caught) {
      if (ticket === latest.current) setLoadError(toErrorBody(caught).message);
    }
  }, [taskId]);

  // Load on arrival and again when the tab regains focus (the contractor may have replied).
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onFocus = () => {
      if (!busyRef.current) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // A question that has been sent and not answered: look again every few seconds.
  const waitingForReply = view ? awaitsReply(view) : false;
  useEffect(() => {
    if (!waitingForReply) return;
    const timer = window.setInterval(() => {
      if (!busyRef.current) void refresh();
    }, REPLY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [waitingForReply, refresh]);

  // The first document opens on its first value to decide.
  useEffect(() => {
    if (!view || activeId !== null) return;
    const first = view.documents[0];
    if (!first) return;
    setActiveId(first.id);
    setSelection((previous) => ({ key: firstSelectable(first), nonce: previous.nonce + 1 }));
  }, [view, activeId]);

  /** Runs one write, adopts the refreshed task it answers with, and reports a refusal through `onError`. */
  async function write(action: () => Promise<TaskView>, onError: (message: string) => void): Promise<TaskView | null> {
    busyRef.current = true;
    setBusy(true);
    try {
      const next = await action();
      latest.current += 1;
      setView(next);
      setLoadError(null);
      notifyReviewTasksChanged();
      return next;
    } catch (caught) {
      onError(toErrorBody(caught).message);
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function select(fieldKey: string) {
    setSelection((previous) => ({ key: fieldKey, nonce: previous.nonce + 1 }));
  }

  function openDocument(documentId: string, fieldKey?: string) {
    const target = view?.documents.find((candidate) => candidate.id === documentId);
    if (!target) return;
    setActiveId(documentId);
    setSelection((previous) => ({ key: fieldKey ?? firstSelectable(target), nonce: previous.nonce + 1 }));
  }

  async function onDecide(row: TaskFieldRow, request: ReviewDecision): Promise<boolean> {
    const proposal = row.proposal;
    if (!proposal) return false;
    setRowErrors(({ [row.field_key]: _cleared, ...rest }) => rest);
    const next = await write(
      () => decide(taskId, proposal.id, request),
      (message) => setRowErrors((previous) => ({ ...previous, [row.field_key]: message })),
    );
    if (!next) return false;
    // After a decision on the selected value, the next value to decide in the document is selected.
    const document = next.documents.find((candidate) => candidate.rows.some((r) => r.field_key === row.field_key));
    if (document) {
      const following = nextUndecidedKey(document.rows, row.field_key);
      setSelection((previous) =>
        previous.key === row.field_key && following ? { key: following, nonce: previous.nonce + 1 } : previous,
      );
    }
    return true;
  }

  async function onSend(recordId: string, text: string): Promise<boolean> {
    setRecordErrors(({ [recordId]: _cleared, ...rest }) => rest);
    const next = await write(
      () => sendQuestion(taskId, recordId, text),
      (message) => setRecordErrors((previous) => ({ ...previous, [recordId]: message })),
    );
    return next !== null;
  }

  async function onResolve(recordId: string, resolution: DiscrepancyResolution, note: string): Promise<boolean> {
    setRecordErrors(({ [recordId]: _cleared, ...rest }) => rest);
    const next = await write(
      () => resolveDiscrepancy(taskId, recordId, resolution, note),
      (message) => setRecordErrors((previous) => ({ ...previous, [recordId]: message })),
    );
    return next !== null;
  }

  async function onComplete() {
    setCompleteError(null);
    await write(() => completeReview(taskId), setCompleteError);
  }

  if (view === null) {
    return (
      <div className="page reviewer-page">
        <p className="crumb">
          <Link to="/reviewer">All tasks</Link>
        </p>
        <h1 className="page-title">Document review</h1>
        {loadError ? (
          <p className="notice error" role="alert">
            {loadError}{" "}
            <button type="button" className="button small" onClick={() => void refresh()}>
              Try again
            </button>
          </p>
        ) : (
          <p className="muted">Loading...</p>
        )}
      </div>
    );
  }

  const activeDoc = view.documents.find((candidate) => candidate.id === activeId) ?? view.documents[0] ?? null;
  const complete = completeState(view);
  const openDifferences = openDiscrepancyCount(view);

  return (
    <div className="page reviewer-page">
      <div className="page-head">
        <div>
          <p className="crumb">
            <Link to="/reviewer">All tasks</Link>
          </p>
          <h1 className="page-title">Document review</h1>
          <p className="muted">
            Application {view.application.id} · Ticket {view.task.jsm_issue_id}
          </p>
        </div>
        <div className="page-head-side">
          <span className={`badge ${taskBadgeClass(view.task.status)}`}>{TASK_STATUS_LABELS[view.task.status]}</span>
          {openDifferences > 0 ? (
            <a className="badge badge-proposed badge-link" href="#differences">
              {plural(openDifferences, "open difference", "open differences")}
            </a>
          ) : null}
          <button type="button" className="button" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      {loadError ? (
        <p className="notice error" role="alert">
          {loadError}
        </p>
      ) : null}

      {view.task.status === "complete" ? (
        <p className="review-complete" role="status">
          Review complete. The application is marked as documents reviewed.
          {openDifferences > 0
            ? ` ${plural(openDifferences, "difference stays", "differences stay")} open until resolved.`
            : ""}
        </p>
      ) : null}

      {activeDoc ? (
        <div className="review-grid" ref={gridRef}>
          <div className="review-left">
            <div className="doc-tabs" role="tablist" aria-label="Documents">
              {view.documents.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  aria-selected={candidate.id === activeDoc.id}
                  className={candidate.id === activeDoc.id ? "doc-tab active" : "doc-tab"}
                  onClick={() => openDocument(candidate.id)}
                >
                  <span className="doc-tab-title">{candidate.title}</span>
                  <span className="doc-tab-caption">{tabCaption(candidate)}</span>
                </button>
              ))}
            </div>
            <ValueList
              key={activeDoc.id}
              doc={activeDoc}
              texts={view.texts}
              selectedKey={selection.key}
              onSelect={select}
              onDecide={onDecide}
              busy={busy}
              errors={rowErrors}
              onClearError={(fieldKey) => setRowErrors(({ [fieldKey]: _cleared, ...rest }) => rest)}
              complete={complete}
              onComplete={() => void onComplete()}
              completeError={completeError}
            />
          </div>
          <div className="review-right">
            <DocumentViewer
              key={activeDoc.id}
              doc={activeDoc}
              selectedKey={selection.key}
              focusNonce={selection.nonce}
              notLocatedCaption={view.texts.not_located_caption}
              onSelect={select}
            />
          </div>
        </div>
      ) : (
        <p className="muted">This task has no documents.</p>
      )}

      <DiscrepancyPanel
        view={view}
        busy={busy}
        errors={recordErrors}
        onSend={onSend}
        onResolve={onResolve}
        onShowValue={(documentId, fieldKey) => {
          openDocument(documentId, fieldKey);
          gridRef.current?.scrollIntoView?.({ block: "start" });
        }}
      />
    </div>
  );
}
