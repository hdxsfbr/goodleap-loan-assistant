import type { ReviewQueueService } from "../types.js";

/**
 * In-process stand-in for the Jira Service Management review queue. `createIssue` returns a
 * generated issue id and `addLink` echoes it back; nothing is stored. In production the
 * Jira Service Management REST client takes its place.
 */
export function createReviewQueueMock(): ReviewQueueService {
  let next = 1000;
  return {
    async createIssue() {
      next += 1;
      return { jsm_issue_id: `REV-${next}` };
    },
    async addLink(jsm_issue_id) {
      return { jsm_issue_id, linked: true as const };
    },
  };
}
