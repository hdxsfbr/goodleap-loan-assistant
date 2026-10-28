import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AUDIT_SCHEMA_VERSION,
  AuditEventSchema,
  type Actor,
  type AuditBase,
  type AuditEvent,
  type AuditEventType,
  type ToolService,
  type VersionsBlock,
} from "@shared/schemas";
import { getVersions } from "./versions.js";

/** Who is acting and where in the conversation: stamped on every event a command appends. */
export interface Ctx {
  application_id: string;
  session_id: string;
  turn_id?: string;
  parent_event_id?: string;
  actor: Actor;
}

/** Where serialized events go: the JSONL file in the server, memory in tests. */
export interface AuditSink {
  appendLine(json: string): void;
  /**
   * Writes several lines as one operation, so a batch of paired events reaches the sink whole or
   * not at all. A sink without it receives the lines one `appendLine` call at a time.
   */
  appendLines?(json: string[]): void;
  /** Empties the sink; called by `reset()`. */
  truncate?(): void;
}

export interface MemorySink extends AuditSink {
  readonly lines: string[];
}

export function createMemorySink(): MemorySink {
  const lines: string[] = [];
  return {
    lines,
    appendLine: (json) => {
      lines.push(json);
    },
    appendLines: (json) => {
      lines.push(...json);
    },
    truncate: () => {
      lines.length = 0;
    },
  };
}

/** Appends one JSON object per line to `path`, creating its directory. With `truncate`, starts empty. */
export function createFileSink(path: string, options: { truncate?: boolean } = {}): AuditSink {
  mkdirSync(dirname(path), { recursive: true });
  if (options.truncate) writeFileSync(path, "");
  return {
    appendLine: (json) => appendFileSync(path, `${json}\n`),
    appendLines: (json) => appendFileSync(path, json.map((line) => `${line}\n`).join("")),
    truncate: () => writeFileSync(path, ""),
  };
}

type Distributive<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type StampedKeys = "event_id" | "seq" | "ts" | "versions" | "schema_version";

/** An event as a caller supplies it: the log fills the id, sequence, time, versions and schema version. */
export type AuditEventInput = Distributive<AuditEvent, StampedKeys>;

/** The payload of one event type: everything but the base fields and the discriminator. */
export type EventPayload<T extends AuditEventType> = Omit<
  Extract<AuditEvent, { type: T }>,
  keyof AuditBase | "type"
>;

export interface AuditLogOptions {
  versions?: () => VersionsBlock;
  now?: () => Date;
  newId?: () => string;
}

export interface AuditLog {
  /**
   * Stamps and validates one event, writes it to the sink, and only then keeps it in memory and
   * advances the sequence, so an event the sink refused leaves no trace.
   */
  append(event: AuditEventInput): AuditEvent;
  /**
   * `append` for events that belong together (a submission and its state change). Every event is
   * stamped and validated before any is written; the sequence numbers run consecutively.
   */
  appendAll(events: AuditEventInput[]): AuditEvent[];
  /** `append` with the base fields taken from `ctx`. */
  emit<T extends AuditEventType>(
    ctx: Ctx,
    type: T,
    payload: EventPayload<T>,
  ): Extract<AuditEvent, { type: T }>;
  /** One application's events in `seq` order. */
  list(applicationId: string): AuditEvent[];
  /** Count of `tool.call` events for one service. */
  countToolCalls(applicationId: string, service: ToolService): number;
  /** Clears memory and empties the sink. There is no update or delete. */
  reset(): void;
}

/** The event a command would append for `type`, with the base fields taken from `ctx`. */
export function auditInput<T extends AuditEventType>(
  ctx: Ctx,
  type: T,
  payload: EventPayload<T>,
): AuditEventInput {
  return { ...baseFromCtx(ctx), type, ...payload } as unknown as AuditEventInput;
}

/** The base fields every event carries, from a command context. */
export function baseFromCtx(ctx: Ctx) {
  return {
    application_id: ctx.application_id,
    session_id: ctx.session_id,
    ...(ctx.turn_id === undefined ? {} : { turn_id: ctx.turn_id }),
    ...(ctx.parent_event_id === undefined ? {} : { parent_event_id: ctx.parent_event_id }),
    actor: ctx.actor,
  };
}

export function createAuditLog(sink: AuditSink, options: AuditLogOptions = {}): AuditLog {
  const versions = options.versions ?? getVersions;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  let events: AuditEvent[] = [];
  let seq = 0;

  function stamp(event: AuditEventInput, sequence: number): AuditEvent {
    return AuditEventSchema.parse({
      ...event,
      event_id: `evt_${newId()}`,
      seq: sequence,
      ts: now().toISOString(),
      versions: versions(),
      schema_version: AUDIT_SCHEMA_VERSION,
    });
  }

  // Order matters: validate and serialize everything, write to the sink, and only then commit to
  // memory and advance `seq`. A throw at any step before the sink call, or from the sink itself,
  // leaves `events` and `seq` as they were.
  function appendAll(inputs: AuditEventInput[]): AuditEvent[] {
    const parsed = inputs.map((input, index) => stamp(input, seq + index + 1));
    const lines = parsed.map((event) => JSON.stringify(event));
    if (parsed.length > 1 && sink.appendLines) {
      sink.appendLines(lines);
      events.push(...parsed);
      seq += parsed.length;
    } else {
      parsed.forEach((event, index) => {
        sink.appendLine(lines[index] as string);
        events.push(event);
        seq += 1;
      });
    }
    return parsed;
  }

  return {
    append: (event) => appendAll([event])[0] as AuditEvent,
    appendAll,
    emit(ctx, type, payload) {
      return appendAll([auditInput(ctx, type, payload)])[0] as Extract<AuditEvent, { type: typeof type }>;
    },
    list: (applicationId) =>
      events.filter((event) => event.application_id === applicationId).map((e) => structuredClone(e)),
    countToolCalls: (applicationId, service) =>
      events.filter(
        (event) =>
          event.application_id === applicationId &&
          event.type === "tool.call" &&
          event.service === service,
      ).length,
    reset() {
      // The sink first: if it cannot be emptied, memory still matches what is on disk.
      sink.truncate?.();
      events = [];
      seq = 0;
    },
  };
}

// The process-wide log. Commands and every other emitter go through `audit`; server/index.ts
// installs the file-backed log at boot and tests install a memory-backed one.
let current: AuditLog = createAuditLog(createMemorySink());

export function installAuditLog(log: AuditLog): void {
  current = log;
}

export const audit: AuditLog = {
  append: (event) => current.append(event),
  appendAll: (events) => current.appendAll(events),
  emit: (ctx, type, payload) => current.emit(ctx, type, payload),
  list: (applicationId) => current.list(applicationId),
  countToolCalls: (applicationId, service) => current.countToolCalls(applicationId, service),
  reset: () => current.reset(),
};
