import Anthropic from "@anthropic-ai/sdk";
import type { ErrorBody, ErrorCode } from "@shared/schemas";

interface ErrorSpec {
  message: string;
  retryable: boolean;
  /** HTTP status when the error ends a plain JSON response. */
  status: number;
}

// The user-facing message and retry behavior of every code (Technical Plan section 8).
const ERROR_TABLE: Record<ErrorCode, ErrorSpec> = {
  "llm.missing_key": {
    message:
      "No API key is set. Add ANTHROPIC_API_KEY to the .env file to turn on the assistant. Payment options, the form, the reviewer and the audit views still work.",
    retryable: false,
    status: 503,
  },
  "llm.auth_failed": {
    message:
      "The API key was rejected. Check ANTHROPIC_API_KEY in the .env file and restart the app.",
    retryable: false,
    status: 502,
  },
  "llm.timeout": {
    message:
      "The assistant took too long to answer. Payment options are computed locally and still work. Try again.",
    retryable: true,
    status: 504,
  },
  "llm.rate_limited": {
    message:
      "The assistant is busy right now. Payment options are computed locally and still work. Try again in a moment.",
    retryable: true,
    status: 429,
  },
  "llm.server_error": {
    message:
      "The assistant's model service had a problem. Payment options are computed locally and still work. Try again.",
    retryable: true,
    status: 502,
  },
  "llm.refusal": {
    message: "The assistant declined to answer that request.",
    retryable: false,
    status: 502,
  },
  "llm.schema_invalid": {
    message: "I couldn't produce field suggestions for that; the explanation is below.",
    retryable: false,
    status: 502,
  },
  "guardrail.judge_unavailable": {
    message:
      "The wording check was unavailable, so the explanation was withheld. The payment options above are still accurate.",
    retryable: true,
    status: 503,
  },
  "catalog.unavailable": {
    message: "The product catalog service is unavailable, so payment options can't be shown right now.",
    retryable: true,
    status: 503,
  },
  "catalog.schema_mismatch": {
    message:
      "The product catalog service returned data in an unexpected format, so payment options can't be shown.",
    retryable: false,
    status: 503,
  },
  "extraction.source_not_located": {
    message: "The value was extracted but its position on the page could not be matched.",
    retryable: false,
    status: 422,
  },
  "extraction.document_type_mismatch": {
    message: "This document does not look like the document expected for its slot.",
    retryable: false,
    status: 422,
  },
  "copilot.disabled": {
    message: "The assistant is disabled by operator.",
    retryable: false,
    status: 403,
  },
  internal: {
    message: "Something went wrong on our side. Please try again.",
    retryable: false,
    status: 500,
  },
};

/** An error that carries a code from the taxonomy, its user-facing message and retry flag. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(code: ErrorCode, message?: string, options?: { retryable?: boolean; cause?: unknown }) {
    const spec = ERROR_TABLE[code];
    super(message ?? spec.message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = options?.retryable ?? spec.retryable;
    this.status = spec.status;
  }

  toBody(): ErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/**
 * A command or request that breaks a rule the caller could have avoided: a submit with pending
 * suggestions, a missing required field, a decision on a finished task, a malformed body. The
 * message is written for the person using the screen. On the wire it carries the code `internal`
 * (the taxonomy has no validation code) with this message and a 4xx status.
 */
export class CommandError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(message: string, options?: { status?: number; details?: Record<string, unknown> }) {
    super(message);
    this.name = "CommandError";
    this.status = options?.status ?? 409;
    this.details = options?.details ?? {};
  }
}

/** Maps a thrown value to an AppError, most specific SDK class first. */
export function mapSdkError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new AppError("llm.auth_failed", undefined, { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError("llm.rate_limited", undefined, { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AppError("llm.timeout", undefined, { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError("llm.timeout", undefined, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new AppError("llm.server_error", undefined, { cause: err });
  }
  return new AppError("internal", undefined, { cause: err });
}

/** The wire body and HTTP status for any thrown value (used by the route error handler). */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) return { status: err.status, body: err.toBody() };
  if (err instanceof CommandError) {
    return {
      status: err.status,
      body: { code: "internal", message: err.message, retryable: false },
    };
  }
  const status = httpStatusOf(err);
  const internal = new AppError("internal");
  return { status: status ?? internal.status, body: internal.toBody() };
}

// body-parser errors (malformed JSON, oversized body) carry a 4xx status.
function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}
