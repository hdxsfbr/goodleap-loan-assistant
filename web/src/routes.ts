import seed from "../../samples/seed.json";

// Paths between screens. The prototype has one application, the seeded one.

const firstApplication = seed.applications[0];
if (!firstApplication) throw new Error("samples/seed.json holds no application.");

export const DEFAULT_APPLICATION_ID: string = firstApplication.id;

export function contractorPath(applicationId: string): string {
  return `/applications/${encodeURIComponent(applicationId)}`;
}

export function homeownerPath(applicationId: string): string {
  return `/applications/${encodeURIComponent(applicationId)}/homeowner`;
}

/** The audit page, optionally opened on one event. */
export function auditPath(applicationId: string, eventId?: string): string {
  const base = `/audit/${encodeURIComponent(applicationId)}`;
  return eventId ? `${base}#${encodeURIComponent(eventId)}` : base;
}
