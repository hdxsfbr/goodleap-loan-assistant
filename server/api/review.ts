import { Router, type Request } from "express";
import { z } from "zod";
import {
  DecisionRequestSchema,
  DiscrepancyResolveRequestSchema,
  DiscrepancySendRequestSchema,
} from "@shared/schemas";
import type { Ctx } from "../audit-log.js";
import { resolveDiscrepancy, sendDiscrepancyQuestion } from "../commands.js";
import { CommandError } from "../errors.js";
import { applyDecision, complete, listTaskSummaries, taskView } from "../review/tasks.js";
import { services } from "../services/index.js";
import { store } from "../store.js";
import { ctxFor, parseBody } from "./http.js";

// The reviewer's routes. The prototype has one reviewer; every write carries them as the actor.
// Writes answer with the refreshed task view, so the screen never has to stitch state together.

const DEMO_REVIEWER_ID = "rev_demo_001";

/**
 * `DecisionRequest` plus the id of the proposal it applies to: the shared request shape carries
 * the action and its inputs, and the route needs to know which value they are for.
 */
export const TaskDecisionRequestSchema = DecisionRequestSchema.extend({
  proposal_id: z.string().min(1),
});

function reviewerCtx(req: Request, applicationId: string): Ctx {
  const reviewer = store.getReviewer(DEMO_REVIEWER_ID);
  return ctxFor(req, applicationId, { type: "reviewer", id: reviewer?.id ?? DEMO_REVIEWER_ID });
}

function requireTask(taskId: string | undefined) {
  const task = taskId ? store.getReviewTask(taskId) : undefined;
  if (!task) throw new CommandError(`Review task ${taskId ?? ""} was not found.`, { status: 404 });
  return task;
}

function requireTaskDiscrepancy(taskId: string, discrepancyId: string | undefined) {
  const record = discrepancyId ? store.getDiscrepancy(discrepancyId) : undefined;
  if (!record || record.review_task_id !== taskId) {
    throw new CommandError(`Discrepancy ${discrepancyId ?? ""} was not found.`, { status: 404 });
  }
  return record;
}

export function createReviewRouter(): Router {
  const router = Router();

  router.get("/api/review/tasks", (_req, res) => {
    const tasks = listTaskSummaries();
    res.json({ tasks, open_count: tasks.filter((t) => t.status !== "complete").length });
  });

  router.get("/api/review/tasks/:id", (req, res) => {
    res.json(taskView(requireTask(req.params.id).id));
  });

  router.get("/api/documents/:id/file", async (req, res) => {
    const file = await services.documents.getFile(req.params.id ?? "");
    res.set("Cache-Control", "private, max-age=300");
    res.type(file.content_type).send(Buffer.from(file.bytes));
  });

  router.post("/api/review/tasks/:id/decisions", (req, res) => {
    const task = requireTask(req.params.id);
    const { proposal_id, ...decision } = parseBody(TaskDecisionRequestSchema, req.body);
    res.json(applyDecision(reviewerCtx(req, task.application_id), task.id, proposal_id, decision));
  });

  router.post("/api/review/tasks/:id/discrepancies/:did/send", (req, res) => {
    const task = requireTask(req.params.id);
    const record = requireTaskDiscrepancy(task.id, req.params.did);
    const body = parseBody(DiscrepancySendRequestSchema, req.body);
    sendDiscrepancyQuestion(reviewerCtx(req, task.application_id), record.id, body.text);
    res.json(taskView(task.id));
  });

  router.post("/api/review/tasks/:id/discrepancies/:did/resolve", (req, res) => {
    const task = requireTask(req.params.id);
    const record = requireTaskDiscrepancy(task.id, req.params.did);
    const body = parseBody(DiscrepancyResolveRequestSchema, req.body);
    resolveDiscrepancy(reviewerCtx(req, task.application_id), record.id, body);
    res.json(taskView(task.id));
  });

  router.post("/api/review/tasks/:id/complete", (req, res) => {
    const task = requireTask(req.params.id);
    res.json(complete(reviewerCtx(req, task.application_id), task.id));
  });

  return router;
}
