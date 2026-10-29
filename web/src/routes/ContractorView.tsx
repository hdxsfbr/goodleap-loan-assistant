import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import type { ApplicationView, DocumentSlot } from "@shared/schemas";
import {
  confirmAll,
  confirmProposal,
  editProposal,
  getApplication,
  loadDemo,
  rejectProposal,
  replyToDiscrepancy,
  setField,
  submitApplication,
} from "../api";
import { ApplicationForm, type FormActions } from "../components/ApplicationForm";
import { CopilotPanel } from "../components/CopilotPanel";
import { REVIEWED_LABEL, SUBMITTED_LABEL } from "../copy";
import { toErrorBody } from "../errors";
import { useConversation } from "../hooks";
import { documentName, SLOT_LABELS, submitGate } from "../present";
import { DEFAULT_APPLICATION_ID } from "../routes";
import { exchangeForMessage } from "../stream";
import { createViewSync, type SyncActivity } from "../sync";
import type { SourceFocus } from "../types";

const SLOTS: readonly DocumentSlot[] = ["pay_stub", "estimate", "scope_letter"];

/**
 * The contractor tab: the application form beside the assistant. Everything on it belongs to one
 * application, so a different id remounts it with fresh state, and an answer still on its way for
 * the old id has nowhere to land.
 */
export function ContractorView() {
  const params = useParams();
  const applicationId = params.applicationId ?? DEFAULT_APPLICATION_ID;
  return <ContractorWorkspace key={applicationId} applicationId={applicationId} />;
}

function ContractorWorkspace({ applicationId }: { applicationId: string }) {
  const conversation = useConversation(applicationId);
  const [view, setView] = useState<ApplicationView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activity, setActivity] = useState<SyncActivity>({ writes: 0, refreshing: false });
  // The newest chat revision whose reload has finished; the form is behind the chat until it catches up.
  const [settledRevision, setSettledRevision] = useState(-1);
  const [focus, setFocus] = useState<SourceFocus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  // Every copy of the application goes through this: writes run one at a time and an older answer never replaces a newer one.
  const [sync] = useState(() =>
    createViewSync<ApplicationView>({
      load: () => getApplication(applicationId),
      onView: (next) => {
        setView(next);
        setLoadError(null);
      },
      onLoadError: (error) => setLoadError(toErrorBody(error).message),
      onActivity: setActivity,
    }),
  );

  useEffect(() => {
    sync.attach();
    return () => sync.detach();
  }, [sync]);

  // Load on arrival and again when the chat may have changed the server's copy.
  useEffect(() => {
    const revision = conversation.revision;
    void sync.refresh().then(() => setSettledRevision((settled) => Math.max(settled, revision)));
  }, [sync, conversation.revision]);

  // Also when the tab regains focus.
  useEffect(() => {
    const onFocus = () => void sync.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [sync]);

  const write = async (work: () => Promise<ApplicationView>): Promise<void> => {
    await sync.write(work);
  };

  const actions: FormActions = {
    setField: (fieldKey, value) => write(() => setField(applicationId, fieldKey, value)),
    confirm: (proposalId) => write(() => confirmProposal(applicationId, proposalId)),
    reject: (proposalId) => write(() => rejectProposal(applicationId, proposalId)),
    edit: (proposalId, value) => write(() => editProposal(applicationId, proposalId, value)),
    confirmAll: () => write(() => confirmAll(applicationId)),
  };

  async function onLoadDemo() {
    setDemoBusy(true);
    setDemoError(null);
    try {
      await write(() => loadDemo(applicationId));
    } catch (error) {
      setDemoError(toErrorBody(error).message);
    } finally {
      setDemoBusy(false);
    }
  }

  async function onSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await write(() => submitApplication(applicationId));
    } catch (error) {
      setSubmitError(toErrorBody(error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (view === null) {
    return (
      <div className="page">
        <h1 className="page-title">Application</h1>
        {loadError ? (
          <p className="notice error" role="alert">
            {loadError}{" "}
            <button type="button" className="button small" onClick={() => void sync.refresh()}>
              Try again
            </button>
          </p>
        ) : (
          <p className="muted">Loading...</p>
        )}
      </div>
    );
  }

  const gate = submitGate(view, {
    turnRunning: conversation.exchanges.some((exchange) => exchange.turn.phase === "running"),
    writing: activity.writes > 0,
    refreshing: activity.refreshing || settledRevision < conversation.revision,
    submitting,
  });

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Application</h1>
        {view.status === "draft" ? (
          <button type="button" className="button" onClick={() => void onLoadDemo()} disabled={demoBusy}>
            Load demo project
          </button>
        ) : null}
      </div>
      {demoError ? (
        <p className="notice error" role="alert">
          {demoError}
        </p>
      ) : null}
      {loadError ? (
        <p className="notice error" role="alert">
          {loadError}
        </p>
      ) : null}

      <div className="workspace">
        <div className="workspace-main">
          <ApplicationForm
            view={view}
            actions={actions}
            canShowSource={(messageId) => exchangeForMessage(conversation.exchanges, messageId) !== null}
            onShowSource={(messageId) => setFocus((previous) => ({ message_id: messageId, nonce: (previous?.nonce ?? 0) + 1 }))}
          />

          <DocumentSlots view={view} />

          <StatusArea
            view={view}
            gateReason={gate.reason}
            submitDisabled={gate.blocked}
            submitError={submitError}
            onSubmit={() => void onSubmit()}
            onReply={(recordId, text) => write(() => replyToDiscrepancy(applicationId, recordId, text))}
          />
        </div>
        <div className="workspace-side">
          <CopilotPanel applicationId={applicationId} view={view} focus={focus} />
        </div>
      </div>
    </div>
  );
}

function DocumentSlots({ view }: { view: ApplicationView }) {
  return (
    <section className="slots-card" aria-labelledby="documents-title">
      <h2 id="documents-title">Documents</h2>
      <ul className="slots">
        {SLOTS.map((slot) => {
          const attached = view.documents.find((document) => document.slot === slot);
          return (
            <li key={slot}>
              <span className="slot-label">{SLOT_LABELS[slot]}</span>
              {attached ? (
                <span className="slot-file">{documentName(attached.file_ref)}</span>
              ) : (
                <span className="slot-empty">Not attached</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface StatusAreaProps {
  view: ApplicationView;
  gateReason: string | null;
  submitDisabled: boolean;
  submitError: string | null;
  onSubmit(): void;
  onReply(recordId: string, text: string): Promise<void>;
}

/** Below the form: the reviewer's question when there is one, the submitted label, or the submit button. */
function StatusArea({ view, gateReason, submitDisabled, submitError, onSubmit, onReply }: StatusAreaProps) {
  if (view.banner) {
    return <ClarificationBanner banner={view.banner} onReply={onReply} />;
  }
  if (view.status !== "draft") {
    return (
      <section className="status-card" aria-label="Status">
        <p className="status-label">{view.status === "documents_reviewed" ? REVIEWED_LABEL : SUBMITTED_LABEL}</p>
      </section>
    );
  }
  return (
    <section className="status-card" aria-label="Submit">
      <div className="submit-row">
        <button type="button" className="button primary" disabled={submitDisabled} onClick={onSubmit}>
          Submit application
        </button>
        {gateReason ? <span className="submit-reason">{gateReason}</span> : null}
      </div>
      {submitError ? (
        <p className="field-error" role="alert">
          {submitError}
        </p>
      ) : null}
    </section>
  );
}

function ClarificationBanner({
  banner,
  onReply,
}: {
  banner: NonNullable<ApplicationView["banner"]>;
  onReply(recordId: string, text: string): Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await onReply(banner.record_id, text.trim());
      setText("");
    } catch (caught) {
      setError(toErrorBody(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="clarification" aria-label="Needs clarification">
      <p className="clarification-text">{banner.text}</p>
      <blockquote className="clarification-question">{banner.question}</blockquote>
      {banner.contractor_reply ? (
        <div className="clarification-reply">
          <p className="label">Your reply</p>
          <p>{banner.contractor_reply}</p>
        </div>
      ) : (
        <form onSubmit={send} className="reply-form">
          <label htmlFor="clarification-reply" className="label">
            Your reply
          </label>
          <textarea
            id="clarification-reply"
            rows={3}
            maxLength={4000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" className="button primary" disabled={busy || text.trim() === ""}>
            Send reply
          </button>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}
