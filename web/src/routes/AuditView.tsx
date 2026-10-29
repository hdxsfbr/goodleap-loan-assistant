import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import type { AuditEvent, AuditResponse } from "@shared/schemas";
import { getAudit } from "../api";
import { toErrorBody } from "../errors";
import {
  eventBadge,
  formatTimestamp,
  summarizeEvent,
  usageText,
  versionEntries,
  versionSummary,
} from "../present";
import { DEFAULT_APPLICATION_ID } from "../routes";

/**
 * The audit page: every event for the application in order, with the raw record behind a click. The
 * page's state belongs to one application, so a different id remounts it empty.
 */
export function AuditView() {
  const params = useParams();
  const applicationId = params.applicationId ?? DEFAULT_APPLICATION_ID;
  return <AuditPage key={applicationId} applicationId={applicationId} />;
}

function AuditPage({ applicationId }: { applicationId: string }) {
  const location = useLocation();
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Only the newest request may set the page, and none may once the page has gone.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const next = await getAudit(applicationId);
      if (ticket !== latest.current) return;
      setAudit(next);
      setError(null);
    } catch (caught) {
      if (ticket === latest.current) setError(toErrorBody(caught).message);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [applicationId]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  // A link from the chat opens the event it names.
  useEffect(() => {
    if (!audit || !location.hash) return;
    let id = location.hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // keep the raw text
    }
    const element = document.getElementById(id);
    if (!element) return;
    if (element instanceof HTMLDetailsElement) element.open = true;
    element.scrollIntoView({ block: "center" });
  }, [audit, location.hash]);

  return (
    <div className="page audit-page">
      <div className="page-head">
        <h1 className="page-title">Audit trail</h1>
        <button type="button" className="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Application {applicationId}
        {audit ? ` · ${audit.events.length} events` : ""}
      </p>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {audit ? (
        <>
          <p className="credit-count">
            Credit engine calls: <strong data-testid="credit-engine-calls">{audit.credit_engine_calls}</strong>
          </p>
          {audit.events.length === 0 ? (
            <p className="muted">Nothing has been recorded for this application yet.</p>
          ) : (
            <ol className="events">
              {audit.events.map((event) => (
                <EventRow key={event.event_id} event={event} />
              ))}
            </ol>
          )}
        </>
      ) : loading ? (
        <p className="muted">Loading...</p>
      ) : null}
    </div>
  );
}

function EventRow({ event }: { event: AuditEvent }) {
  const [opened, setOpened] = useState(false);
  const badge = eventBadge(event);
  const usage = usageText(event);
  return (
    <li>
      <details id={event.event_id} className="event" onToggle={(toggle) => toggle.currentTarget.open && setOpened(true)}>
        <summary>
          <span className="event-seq">{event.seq}</span>
          <span className="event-type">{event.type}</span>
          <span className="event-summary">{summarizeEvent(event)}</span>
          <span className="event-meta">
            <span className="event-actor">
              {event.actor.type}:{event.actor.id}
            </span>
            <time dateTime={event.ts}>{formatTimestamp(event.ts)}</time>
            <span className="event-version">{versionSummary(event.versions)}</span>
            {badge ? <span className={`badge badge-${badge.toLowerCase()}`}>{badge}</span> : null}
          </span>
          {usage ? <span className="event-usage">{usage}</span> : null}
        </summary>
        {opened ? (
          <div className="event-body">
            <h3>Versions</h3>
            <dl className="versions">
              {versionEntries(event.versions).map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <h3>Raw record</h3>
            <pre className="raw-record">{JSON.stringify(event, null, 2)}</pre>
          </div>
        ) : null}
      </details>
    </li>
  );
}
