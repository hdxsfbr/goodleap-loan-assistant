import type { MockEnvelope, ToolService } from "@shared/schemas";
import { audit, type Ctx } from "../audit-log.js";
import { CATALOG } from "../domain/catalog.js";
import { createCatalogMock } from "./catalog/mock.js";
import { createContractorProfileMock } from "./contractor-profile/mock.js";
import { CreditEngineStub } from "./credit-engine/stub.js";
import { createDocumentsMock } from "./documents/mock.js";
import { PlaidStub } from "./plaid/stub.js";
import { createReviewQueueMock } from "./review-queue/mock-jsm.js";
import type {
  CatalogService,
  ContractorProfileService,
  CreditEngineService,
  DocumentsService,
  PlaidService,
  ReviewQueueService,
} from "./types.js";

export * from "./types.js";

// Composition root. Each field is an in-process mock behind its interface. In production the
// composition root selects the real client instead (Technical Plan section 10):
//   catalog           -> the loan product catalog service client
//   creditEngine      -> the existing credit decision engine client (never called by this code)
//   plaid             -> the existing Plaid integration, unchanged
//   contractorProfile -> the contractor profile service client
//   documents         -> document management, with Textract positioned text behind the consumer
//   reviewQueue       -> the Jira Service Management REST client
export interface Services {
  catalog: CatalogService;
  creditEngine: CreditEngineService;
  plaid: PlaidService;
  contractorProfile: ContractorProfileService;
  documents: DocumentsService;
  reviewQueue: ReviewQueueService;
}

export const services: Services = {
  catalog: createCatalogMock(() => CATALOG),
  creditEngine: new CreditEngineStub(),
  plaid: new PlaidStub(),
  contractorProfile: createContractorProfileMock(),
  documents: createDocumentsMock(),
  reviewQueue: createReviewQueueMock(),
};

export interface MockCallOptions {
  /** What the call was given, recorded on the `tool.call` event. */
  input?: unknown;
  /** Which canned data answered; defaults to `<service>.<method>`. */
  fixture_id?: string;
  /** The Options record this call produced, when it is a payment calculation. */
  options_id?: string;
}

export type WithMock<T> = T & { _mock: MockEnvelope };

async function runLogged<T>(
  ctx: Ctx,
  service: ToolService,
  method: string,
  fn: () => T | Promise<T>,
  options: MockCallOptions,
  envelope?: MockEnvelope,
): Promise<{ result: T; event_id: string }> {
  const started = performance.now();
  const record = (output: unknown) =>
    audit.emit(ctx, "tool.call", {
      service,
      method,
      input: options.input ?? null,
      output,
      ...(options.options_id === undefined ? {} : { options_id: options.options_id }),
      ...(envelope === undefined ? {} : { _mock: envelope }),
      latency_ms: Math.round((performance.now() - started) * 1000) / 1000,
    });
  try {
    const result = await fn();
    return { result, event_id: record(result).event_id };
  } catch (err) {
    record({ error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Runs a mock service call, attaches `_mock: { service, fixture_id, mock_version: 1 }` to the
 * result and appends the `tool.call` event. Every caller of a mock goes through this, so the
 * logging responsibility sits in one place. A call that throws is logged and rethrown.
 */
export async function withMockEvent<T extends object>(
  ctx: Ctx,
  service: ToolService,
  method: string,
  fn: () => T | Promise<T>,
  options: MockCallOptions = {},
): Promise<{ result: WithMock<T>; event_id: string }> {
  const envelope: MockEnvelope = {
    service,
    fixture_id: options.fixture_id ?? `${service}.${method}`,
    mock_version: 1,
  };
  const { result, event_id } = await runLogged(ctx, service, method, fn, options, envelope);
  return { result: { ...result, _mock: envelope }, event_id };
}

export async function withMock<T extends object>(
  ctx: Ctx,
  service: ToolService,
  method: string,
  fn: () => T | Promise<T>,
  options: MockCallOptions = {},
): Promise<WithMock<T>> {
  return (await withMockEvent(ctx, service, method, fn, options)).result;
}

/**
 * Like `withMock` for in-process code that is real rather than a mock (the calculator): appends
 * the `tool.call` event with no `_mock` envelope, so the audit page shows it as LIVE.
 */
export async function withToolCall<T>(
  ctx: Ctx,
  service: ToolService,
  method: string,
  fn: () => T | Promise<T>,
  options: MockCallOptions = {},
): Promise<{ result: T; event_id: string }> {
  return runLogged(ctx, service, method, fn, options);
}
