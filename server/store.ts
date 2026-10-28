import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ApplicationSchema,
  ContractorSchema,
  ReviewerSchema,
  type Application,
  type Contractor,
  type DiscrepancyRecord,
  type DocumentRecord,
  type DocumentSlot,
  type OptionsRecord,
  type ProposalSourceKind,
  type ProposalState,
  type ProposedValue,
  type ReviewTask,
  type Reviewer,
  type TranscriptMessage,
} from "@shared/schemas";
import { PROJECT_ROOT } from "./versions.js";

// In-memory state for the process lifetime. `loadSeed()` and `reset()` are the only writers
// outside server/commands.ts, which reaches the maps through `storeWriter()`. Every read helper
// returns a copy, so a caller cannot change state by mutating what it was handed.

export interface StoreState {
  contractors: Map<string, Contractor>;
  reviewers: Map<string, Reviewer>;
  applications: Map<string, Application>;
  proposals: Map<string, ProposedValue>;
  discrepancies: Map<string, DiscrepancyRecord>;
  reviewTasks: Map<string, ReviewTask>;
  documents: Map<string, DocumentRecord>;
  /** Transcript messages by application id, in arrival order. */
  messages: Map<string, TranscriptMessage[]>;
  options: Map<string, OptionsRecord>;
  counters: Map<string, number>;
}

function emptyState(): StoreState {
  return {
    contractors: new Map(),
    reviewers: new Map(),
    applications: new Map(),
    proposals: new Map(),
    discrepancies: new Map(),
    reviewTasks: new Map(),
    documents: new Map(),
    messages: new Map(),
    options: new Map(),
    counters: new Map(),
  };
}

let state: StoreState = emptyState();

/** The mutable maps. Imported by server/commands.ts only; a test asserts that. */
export function storeWriter(): StoreState {
  return state;
}

/** `m_1`, `p_2`, `doc_3`: readable ids that restart after `reset()`. */
export function nextId(prefix: string): string {
  const next = (state.counters.get(prefix) ?? 0) + 1;
  state.counters.set(prefix, next);
  return `${prefix}_${next}`;
}

const copy = <T>(value: T): T => structuredClone(value);
const copyOrUndefined = <T>(value: T | undefined): T | undefined =>
  value === undefined ? undefined : copy(value);

/** The slot prefix of a document field key (`pay_stub.gross_pay` -> `pay_stub`), else undefined. */
export function slotOfFieldKey(fieldKey: string): string | undefined {
  const dot = fieldKey.indexOf(".");
  return dot > 0 ? fieldKey.slice(0, dot) : undefined;
}

export interface ProposalFilter {
  state?: ProposalState;
  field_key?: string;
  source_kind?: ProposalSourceKind;
}

export const store = {
  getContractor: (id: string): Contractor | undefined => copyOrUndefined(state.contractors.get(id)),
  getReviewer: (id: string): Reviewer | undefined => copyOrUndefined(state.reviewers.get(id)),

  getApplication: (id: string): Application | undefined =>
    copyOrUndefined(state.applications.get(id)),
  listApplications: (): Application[] => [...state.applications.values()].map(copy),

  getProposal: (id: string): ProposedValue | undefined => copyOrUndefined(state.proposals.get(id)),
  /** One application's proposals in creation order. */
  listProposals(applicationId: string, filter: ProposalFilter = {}): ProposedValue[] {
    return [...state.proposals.values()]
      .filter(
        (p) =>
          p.application_id === applicationId &&
          (filter.state === undefined || p.state === filter.state) &&
          (filter.field_key === undefined || p.field_key === filter.field_key) &&
          (filter.source_kind === undefined || p.source.kind === filter.source_kind),
      )
      .map(copy);
  },
  /** Proposals of a review task: the application's document values for the task's slots. */
  proposalsForTask(taskId: string): ProposedValue[] {
    const task = state.reviewTasks.get(taskId);
    if (!task) return [];
    const slots = new Set<string>(
      task.document_ids
        .map((id) => state.documents.get(id)?.slot)
        .filter((slot): slot is DocumentSlot => slot !== undefined),
    );
    return [...state.proposals.values()]
      .filter((p) => {
        const slot = slotOfFieldKey(p.field_key);
        return p.application_id === task.application_id && slot !== undefined && slots.has(slot);
      })
      .map(copy);
  },

  getDiscrepancy: (id: string): DiscrepancyRecord | undefined =>
    copyOrUndefined(state.discrepancies.get(id)),
  listDiscrepancies: (applicationId: string): DiscrepancyRecord[] =>
    [...state.discrepancies.values()].filter((d) => d.application_id === applicationId).map(copy),

  getReviewTask: (id: string): ReviewTask | undefined => copyOrUndefined(state.reviewTasks.get(id)),
  listReviewTasks: (applicationId?: string): ReviewTask[] =>
    [...state.reviewTasks.values()]
      .filter((t) => applicationId === undefined || t.application_id === applicationId)
      .map(copy),

  getDocument: (id: string): DocumentRecord | undefined => copyOrUndefined(state.documents.get(id)),
  listDocuments: (applicationId: string): DocumentRecord[] =>
    [...state.documents.values()].filter((d) => d.application_id === applicationId).map(copy),

  getMessage(id: string): TranscriptMessage | undefined {
    for (const messages of state.messages.values()) {
      const found = messages.find((m) => m.id === id);
      if (found) return copy(found);
    }
    return undefined;
  },
  listMessages: (applicationId: string): TranscriptMessage[] =>
    (state.messages.get(applicationId) ?? []).map(copy),

  getOptions: (id: string): OptionsRecord | undefined => copyOrUndefined(state.options.get(id)),
  listOptions: (applicationId: string): OptionsRecord[] =>
    [...state.options.values()].filter((o) => o.application_id === applicationId).map(copy),

  /** Writer 1 of 2 outside commands: forget everything, including the id counters. */
  reset(): void {
    state = emptyState();
  },

  /** Writer 2 of 2 outside commands: load `samples/seed.json` into an empty store. */
  loadSeed(path: string = DEFAULT_SEED_PATH): void {
    const seed = SeedSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    for (const contractor of seed.contractors) state.contractors.set(contractor.id, contractor);
    for (const reviewer of seed.reviewers) state.reviewers.set(reviewer.id, reviewer);
    for (const application of seed.applications) {
      state.applications.set(application.id, copy(application));
    }
  },
};

const DEFAULT_SEED_PATH = `${PROJECT_ROOT}samples/seed.json`;

const SeedSchema = z
  .object({
    contractors: z.array(ContractorSchema),
    reviewers: z.array(ReviewerSchema),
    applications: z.array(ApplicationSchema),
  })
  .strict();
