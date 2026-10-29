import type { Catalog, Contractor } from "@shared/schemas";

// One interface per external system. The prototype binds each to an in-process mock (see
// services/index.ts); production binds each to the real client named there.

/** The loan product catalog. */
export interface CatalogService {
  getCatalog(): Promise<Catalog>;
}

/**
 * The existing credit decision engine. The assistant never calls it: approval and denial belong
 * to the engine, and an application under document review is blocked from it. The interface
 * exists so that fact is visible in the code, and the audit page counts `tool.call` events for
 * this service, which must read zero.
 */
export interface CreditEngineService {
  decide(applicationId: string): Promise<unknown>;
}

/** Plaid income verification, unchanged in production and first in line before documents. */
export interface PlaidService {
  startVerification(applicationId: string): Promise<{ link_token: string }>;
}

export type ContractorProfile = Contractor;

/** The contractor profile service. */
export interface ContractorProfileService {
  getProfile(contractorId: string): Promise<ContractorProfile>;
}

export interface StoredFile {
  file_ref: string;
  content_type: string;
  bytes: Uint8Array;
}

/** Document management: the files behind an application's document slots. */
export interface DocumentsService {
  getFile(documentId: string): Promise<StoredFile>;
  /**
   * Keeps the bytes of a file the contractor attached, under the id of the document that will
   * carry it, and returns the `file_ref` for that document's record. `name` is the file's name as
   * the contractor knows it.
   */
  putFile(documentId: string, name: string, bytes: Uint8Array): Promise<{ file_ref: string; size_bytes: number }>;
  /** Forgets a file stored with `putFile`. Safe to call for an id that holds none. */
  removeFile(documentId: string): Promise<void>;
}

/** The review queue of record (Jira Service Management). */
export interface ReviewQueueService {
  createIssue(input: { application_id: string; summary: string }): Promise<{ jsm_issue_id: string }>;
  addLink(
    jsm_issue_id: string,
    link: { task_id: string; url: string },
  ): Promise<{ jsm_issue_id: string; linked: true }>;
}
