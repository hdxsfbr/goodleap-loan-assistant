import type { DecisionRequest } from "@shared/schemas";
import type { TaskSummary } from "../../server/review/tasks";

// The reviewer screen's types. The task view is defined where it is built (server/review/tasks.ts),
// and the screen imports it from there as types only, so the two cannot drift: nothing here exists
// at runtime, and a change to the view's shape fails the web type-check.
export type {
  DecisionAction,
  DerivedInputView,
  RowLocation,
  RowStatus,
  TaskDecision,
  TaskDiscrepancyView,
  TaskDocumentFlag,
  TaskDocumentView,
  TaskFieldRow,
  TaskSummary,
  TaskView,
} from "../../server/review/tasks";

/** What the reviewer sends for one value: confirm, correct or flag, with the inputs each needs. */
export type ReviewDecision = DecisionRequest;

/** `GET /api/review/tasks`: the tasks and how many of them are not complete. */
export interface TaskList {
  tasks: TaskSummary[];
  open_count: number;
}
