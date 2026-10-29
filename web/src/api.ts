import { z } from "zod";
import {
  ApplicationViewSchema,
  AuditResponseSchema,
  ErrorBodySchema,
  HealthResponseSchema,
  HomeownerViewPropsSchema,
  OptionsLineSchema,
  type ApplicationView,
  type AuditResponse,
  type FieldEditRequest,
  type HealthResponse,
  type HomeownerViewProps,
  type HomeownerViewRequest,
  type DiscrepancyReplyRequest,
  type ProposalRejectRequest,
  type TurnRequest,
} from "@shared/schemas";
import { CONNECTION_ERROR, UNREADABLE_REPLY_ERROR, ApiError } from "./errors";
import { disclosureCovers, displayCovers } from "./present";
import { readTurnBody, type ClientEvent } from "./stream";
import type { OptionsLine } from "./types";

// Typed fetch helpers for every route the screens use. Every request carries `x-session-id`.

let sessionId: string | null = null;

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined") crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One id per page load, held in module memory only: a reload starts a new session, a second tab has its own. */
export function getSessionId(): string {
  sessionId ??= makeSessionId();
  return sessionId;
}

function headers(hasBody: boolean): Record<string, string> {
  return {
    "x-session-id": getSessionId(),
    accept: "application/json",
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

/** The error a non-2xx response describes, in the server's `{ code, message, retryable }` shape. */
async function errorFromResponse(response: Response): Promise<ApiError> {
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json());
    if (parsed.success) return new ApiError(parsed.data, response.status);
  } catch {
    // fall through to the generic error
  }
  return new ApiError(UNREADABLE_REPLY_ERROR, response.status);
}

async function request<S extends z.ZodTypeAny>(
  method: "GET" | "POST",
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(CONNECTION_ERROR, 0);
  }
  if (!response.ok) throw await errorFromResponse(response);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError(UNREADABLE_REPLY_ERROR, response.status);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`${method} ${path}: the reply did not match its schema`, parsed.error.issues);
    throw new ApiError(UNREADABLE_REPLY_ERROR, response.status);
  }
  return parsed.data;
}

const app = (applicationId: string) => `/api/applications/${encodeURIComponent(applicationId)}`;

export function getHealth(): Promise<HealthResponse> {
  return request("GET", "/api/healthz", HealthResponseSchema);
}

export function getApplication(applicationId: string): Promise<ApplicationView> {
  return request("GET", app(applicationId), ApplicationViewSchema);
}

/** Types a value into a field. Money, enums and ZIP codes are parsed by the server. */
export function setField(applicationId: string, fieldKey: string, value: string): Promise<ApplicationView> {
  const body: FieldEditRequest = { value };
  return request("POST", `${app(applicationId)}/fields/${encodeURIComponent(fieldKey)}`, ApplicationViewSchema, body);
}

export function confirmProposal(applicationId: string, proposalId: string): Promise<ApplicationView> {
  return request("POST", `${app(applicationId)}/proposals/${encodeURIComponent(proposalId)}/confirm`, ApplicationViewSchema, {});
}

export function rejectProposal(applicationId: string, proposalId: string): Promise<ApplicationView> {
  const body: ProposalRejectRequest = { reason_code: "dismissed_by_contractor" };
  return request("POST", `${app(applicationId)}/proposals/${encodeURIComponent(proposalId)}/reject`, ApplicationViewSchema, body);
}

/** Replaces a proposed value with the contractor's own (`editValue`). */
export function editProposal(applicationId: string, proposalId: string, value: string): Promise<ApplicationView> {
  const body: FieldEditRequest = { value };
  return request("POST", `${app(applicationId)}/proposals/${encodeURIComponent(proposalId)}/edit`, ApplicationViewSchema, body);
}

export function confirmAll(applicationId: string): Promise<ApplicationView> {
  return request("POST", `${app(applicationId)}/confirm-all`, ApplicationViewSchema, {});
}

export function submitApplication(applicationId: string): Promise<ApplicationView> {
  return request("POST", `${app(applicationId)}/submit`, ApplicationViewSchema, {});
}

export function loadDemo(applicationId: string): Promise<ApplicationView> {
  return request("POST", `${app(applicationId)}/load-demo`, ApplicationViewSchema, {});
}

export function replyToDiscrepancy(applicationId: string, discrepancyId: string, text: string): Promise<ApplicationView> {
  const body: DiscrepancyReplyRequest = { text };
  return request(
    "POST",
    `${app(applicationId)}/discrepancies/${encodeURIComponent(discrepancyId)}/reply`,
    ApplicationViewSchema,
    body,
  );
}

export function getAudit(applicationId: string): Promise<AuditResponse> {
  return request("GET", `${app(applicationId)}/audit`, AuditResponseSchema);
}

/**
 * The homeowner view's props for one stored options record. A reply that misses an option in its
 * display strings or its disclosure block is refused like any unreadable reply: the screen never
 * shows a card without its payment, term, APR and TILA box.
 */
export async function createHomeownerView(applicationId: string, optionsId: string): Promise<HomeownerViewProps> {
  const body: HomeownerViewRequest = { options_id: optionsId };
  const props = await request("POST", `${app(applicationId)}/homeowner-view`, HomeownerViewPropsSchema, body);
  if (!displayCovers(props.options.options, props.options_display) || !disclosureCovers(props.options.options, props.disclosure_block)) {
    console.error("homeowner view: the display strings or the disclosure block do not cover every option");
    throw new ApiError(UNREADABLE_REPLY_ERROR, 200);
  }
  return props;
}

/** The calculator button: options for the form's amount, computed without a model. */
export async function requestPaymentOptions(applicationId: string): Promise<OptionsLine> {
  // The route answers with the `options` line's shape; the discriminator is added here when absent.
  const loose = z.object({}).passthrough();
  const json = await request("POST", `${app(applicationId)}/copilot/payment-options`, loose, {});
  const parsed = OptionsLineSchema.safeParse({ ...json, type: "options" });
  if (!parsed.success) {
    console.error("payment options: the reply did not match the options line", parsed.error.issues);
    throw new ApiError(UNREADABLE_REPLY_ERROR, 200);
  }
  if (!displayCovers(parsed.data.calculator_result.options, parsed.data.options_display)) {
    console.error("payment options: an option has no display entry");
    throw new ApiError(UNREADABLE_REPLY_ERROR, 200);
  }
  return parsed.data;
}

/**
 * Posts a contractor message and reads the reply as newline-delimited JSON, dispatching each line
 * as it arrives. Never throws: a failure to connect, a non-2xx reply and a line that does not
 * match the schema each dispatch an `error` event and stop.
 */
export async function streamTurn(
  applicationId: string,
  text: string,
  onEvent: (event: ClientEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body: TurnRequest = { text };
  let response: Response;
  try {
    response = await fetch(`${app(applicationId)}/copilot/turns`, {
      method: "POST",
      headers: { ...headers(true), accept: "application/x-ndjson" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    onEvent({ type: "error", ...CONNECTION_ERROR });
    return;
  }
  if (!response.ok) {
    const failure = await errorFromResponse(response);
    onEvent({ type: "error", code: failure.code, message: failure.message, retryable: failure.retryable });
    return;
  }
  if (!response.body) {
    onEvent({ type: "error", ...UNREADABLE_REPLY_ERROR });
    return;
  }

  await readTurnBody(response.body, onEvent);
}
