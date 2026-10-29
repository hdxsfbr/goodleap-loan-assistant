import { readFileSync } from "node:fs";
import express, { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { z } from "zod";
import {
  ApplicationSchema,
  ContractorSchema,
  ReviewerSchema,
  type HealthResponse,
} from "@shared/schemas";
import { audit } from "../audit-log.js";
import { config } from "../config.js";
import { toErrorResponse } from "../errors.js";
import { store } from "../store.js";
import { PROJECT_ROOT, getVersions } from "../versions.js";
import { createApplicationsRouter } from "./applications.js";
import { createCopilotRouter } from "./copilot.js";
import { createReviewRouter } from "./review.js";

const DEFAULT_SEED_PATH = `${PROJECT_ROOT}samples/seed.json`;

// The shape `store.loadSeed` accepts, so that a reset can prove the seed loads before it changes anything.
const SeedSchema = z
  .object({
    contractors: z.array(ContractorSchema),
    reviewers: z.array(ReviewerSchema),
    applications: z.array(ApplicationSchema),
  })
  .strict();

/**
 * Maps a thrown value to the wire shape `{ code, message, retryable }`: an `AppError` keeps its
 * code, a `CommandError` carries its own message under `internal`, anything else is `internal`
 * with a generic message. Express 5 routes rejected promises here without a wrapper.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { status, body } = toErrorResponse(err);
  if (body.code === "internal" && status >= 500) console.error("Unhandled error:", err);
  res.status(status).json(body);
};

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ code: "internal", message: "That page does not exist.", retryable: false });
};

export interface ApiRouterOptions {
  /** The seed file `/api/reset` loads; the committed `samples/seed.json` by default. */
  seedPath?: string;
}

/** The `/api` router: JSON parsing, health, reset, the route modules and the error handler. */
export function createApiRouter(options: ApiRouterOptions = {}): Router {
  const seedPath = options.seedPath ?? DEFAULT_SEED_PATH;
  const router = Router();
  router.use("/api", express.json({ limit: "1mb" }));

  router.get("/api/healthz", (_req, res) => {
    const health: HealthResponse = {
      has_llm_key: config.hasLlmKey,
      copilot_enabled: config.copilotEnabled,
      extraction_enabled: config.extractionEnabled,
      versions: getVersions(),
    };
    res.json(health);
  });

  router.post("/api/reset", (_req, res) => {
    // Order: prove the seed loads, empty the audit file (the step most likely to fail on a real
    // disk), then swap the store. A failure before the last step leaves the data and its history
    // in place; the last step cannot fail on a seed that has just parsed.
    SeedSchema.parse(JSON.parse(readFileSync(seedPath, "utf8")));
    audit.reset();
    store.reset();
    store.loadSeed(seedPath);
    res.json({ ok: true });
  });

  router.use(createApplicationsRouter());
  router.use(createCopilotRouter());
  router.use(createReviewRouter());

  router.use("/api", notFound);
  router.use(errorHandler);
  return router;
}
