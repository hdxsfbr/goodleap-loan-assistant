import { audit } from "../audit-log.js";

// One run at a time for work that must not overlap: a second call with the same key while the
// first is still running gets the first one's promise instead of starting again. Used for reading
// a document and for opening an application's review task, both of which a retry or a double
// submit can start twice.

const running = new Map<string, Promise<unknown>>();

/**
 * Names the application's audit stream by its first event, which is unique to it: a key from an
 * earlier stream (a reset in tests) never matches a call made against the current one.
 */
function streamOf(applicationId: string): string {
  return audit.list(applicationId)[0]?.event_id ?? "none";
}

/** Runs `work` unless a run with the same key for this application is already going; then shares that run. */
export function singleFlight<T>(applicationId: string, key: string, work: () => Promise<T>): Promise<T> {
  const id = `${streamOf(applicationId)}|${applicationId}|${key}`;
  const existing = running.get(id);
  if (existing) return existing as Promise<T>;
  const attempt: Promise<T> = work().finally(() => {
    if (running.get(id) === attempt) running.delete(id);
  });
  running.set(id, attempt);
  return attempt;
}
