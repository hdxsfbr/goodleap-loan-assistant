import type { Request } from "express";
import type { z } from "zod";
import type { Actor } from "@shared/schemas";
import type { Ctx } from "../audit-log.js";
import { CommandError } from "../errors.js";
import { store } from "../store.js";

// Helpers shared by the route modules.

const SESSION_HEADER = "x-session-id";
const MAX_SESSION_ID_LENGTH = 100;

/** The client-generated session id from `x-session-id`, stamped on every event of a write. */
export function sessionIdOf(req: Request): string {
  const raw = req.header(SESSION_HEADER)?.trim();
  return raw ? raw.slice(0, MAX_SESSION_ID_LENGTH) : "no-session";
}

/** The command context for one request on one application. */
export function ctxFor(req: Request, applicationId: string, actor: Actor): Ctx {
  return { application_id: applicationId, session_id: sessionIdOf(req), actor };
}

/** The application, or a 404 `CommandError`. */
export function requireApplication(applicationId: string) {
  const application = store.getApplication(applicationId);
  if (!application) {
    throw new CommandError(`Application ${applicationId} was not found.`, { status: 404 });
  }
  return application;
}

/** Validates a request body against its schema; a bad body is a 400. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CommandError(
      first ? `The request was not valid: ${first.path.join(".") || "body"} ${first.message}.` : "The request was not valid.",
      { status: 400 },
    );
  }
  return parsed.data;
}

/** The contractor who owns an application, as the actor of contractor-side writes. */
export function contractorCtx(req: Request, applicationId: string): Ctx {
  const application = requireApplication(applicationId);
  return ctxFor(req, applicationId, { type: "contractor", id: application.contractor_id });
}
