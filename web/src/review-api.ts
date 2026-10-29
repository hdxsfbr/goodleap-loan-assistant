import { ErrorBodySchema, type DiscrepancyResolution } from "@shared/schemas";
import { getSessionId } from "./api";
import { ApiError, CONNECTION_ERROR, UNREADABLE_REPLY_ERROR } from "./errors";
import type { ReviewDecision, TaskList, TaskView } from "./review-types";

// Typed fetch helpers for the reviewer's routes. Every request carries `x-session-id`; every write
// answers with the refreshed task view, so the screen adopts the reply and never stitches state.
// `createReviewApi` takes the fetch function and a base URL so the same calls run outside a page.

/** Fired on `window` after a write that may change the count of open tasks (the tab badge listens). */
export const REVIEW_TASKS_CHANGED = "review-tasks-changed";

export function notifyReviewTasksChanged(): void {
  // `globalThis` is the window in a page and has no `dispatchEvent` elsewhere (the tests run in node).
  const target = globalThis as unknown as { dispatchEvent?: (event: Event) => boolean };
  target.dispatchEvent?.(new Event(REVIEW_TASKS_CHANGED));
}

export interface ReviewApi {
  listTasks(): Promise<TaskList>;
  getTask(taskId: string): Promise<TaskView>;
  decide(taskId: string, proposalId: string, decision: ReviewDecision): Promise<TaskView>;
  sendQuestion(taskId: string, discrepancyId: string, text: string): Promise<TaskView>;
  resolveDiscrepancy(
    taskId: string,
    discrepancyId: string,
    resolution: DiscrepancyResolution,
    note: string,
  ): Promise<TaskView>;
  completeReview(taskId: string): Promise<TaskView>;
  /** The PDF behind a task document, as a blob the viewer renders. */
  getDocumentFile(fileUrl: string): Promise<Blob>;
}

export interface ReviewApiOptions {
  /** Defaults to the global `fetch`, looked up at call time. */
  fetch?: typeof fetch;
  /** Prepended to every path; empty in the browser, the server's origin elsewhere. */
  baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parts of a task view the screen reads, checked before it is trusted. */
export function isTaskView(value: unknown): value is TaskView {
  if (!isRecord(value) || !isRecord(value.task) || !isRecord(value.texts) || !isRecord(value.application)) return false;
  return (
    typeof value.task.id === "string" &&
    Array.isArray(value.documents) &&
    Array.isArray(value.discrepancies) &&
    typeof value.undecided_count === "number" &&
    typeof value.can_complete === "boolean" &&
    isRecord(value.texts.flag_reasons)
  );
}

export function isTaskList(value: unknown): value is TaskList {
  return isRecord(value) && Array.isArray(value.tasks) && typeof value.open_count === "number";
}

export function createReviewApi(options: ReviewApiOptions = {}): ReviewApi {
  const base = options.baseUrl ?? "";

  async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const doFetch = options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          "x-session-id": getSessionId(),
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(CONNECTION_ERROR, 0);
    }
    if (response.ok) return response;
    try {
      const parsed = ErrorBodySchema.safeParse(await response.json());
      if (parsed.success) throw new ApiError(parsed.data, response.status);
    } catch (caught) {
      if (caught instanceof ApiError) throw caught;
    }
    throw new ApiError(UNREADABLE_REPLY_ERROR, response.status);
  }

  async function json<T>(
    method: "GET" | "POST",
    path: string,
    guard: (value: unknown) => value is T,
    body?: unknown,
  ): Promise<T> {
    const response = await send(method, path, body);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ApiError(UNREADABLE_REPLY_ERROR, response.status);
    }
    if (!guard(parsed)) {
      console.error(`${method} ${path}: the reply was not the shape the screen reads`);
      throw new ApiError(UNREADABLE_REPLY_ERROR, response.status);
    }
    return parsed;
  }

  const task = (taskId: string) => `/api/review/tasks/${encodeURIComponent(taskId)}`;
  const discrepancy = (taskId: string, discrepancyId: string) =>
    `${task(taskId)}/discrepancies/${encodeURIComponent(discrepancyId)}`;

  return {
    listTasks: () => json("GET", "/api/review/tasks", isTaskList),
    getTask: (taskId) => json("GET", task(taskId), isTaskView),
    decide: (taskId, proposalId, decision) =>
      json("POST", `${task(taskId)}/decisions`, isTaskView, { ...decision, proposal_id: proposalId }),
    sendQuestion: (taskId, discrepancyId, text) =>
      json("POST", `${discrepancy(taskId, discrepancyId)}/send`, isTaskView, { text }),
    resolveDiscrepancy: (taskId, discrepancyId, resolution, note) =>
      json("POST", `${discrepancy(taskId, discrepancyId)}/resolve`, isTaskView, { resolution, note }),
    completeReview: (taskId) => json("POST", `${task(taskId)}/complete`, isTaskView, {}),
    getDocumentFile: async (fileUrl) => {
      const response = await send("GET", fileUrl);
      return response.blob();
    },
  };
}

const defaultApi = createReviewApi();

export const listTasks = defaultApi.listTasks;
export const getTask = defaultApi.getTask;
export const decide = defaultApi.decide;
export const sendQuestion = defaultApi.sendQuestion;
export const resolveDiscrepancy = defaultApi.resolveDiscrepancy;
export const completeReview = defaultApi.completeReview;
export const getDocumentFile = defaultApi.getDocumentFile;
