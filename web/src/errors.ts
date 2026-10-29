import type { ErrorBody, ErrorCode } from "@shared/schemas";
import { CONNECTION_ERROR_MESSAGE, UNREADABLE_REPLY_MESSAGE } from "./copy";

/** A failed request, in the server's error taxonomy. `status` is 0 when no reply arrived. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(body: ErrorBody, status: number) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.retryable = body.retryable;
    this.status = status;
  }
}

export const CONNECTION_ERROR: ErrorBody = {
  code: "internal",
  message: CONNECTION_ERROR_MESSAGE,
  retryable: true,
};

export const UNREADABLE_REPLY_ERROR: ErrorBody = {
  code: "internal",
  message: UNREADABLE_REPLY_MESSAGE,
  retryable: false,
};

/** The wire shape of any thrown value, for screens that show a failure. */
export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return UNREADABLE_REPLY_ERROR;
}
