// The copilot routes: the streamed turn endpoint and the no-model "Show payment options" button.

import { Router } from "express";
import { StreamLineSchema, TurnRequestSchema, type StreamLine } from "@shared/schemas";
import { withMock, services } from "../services/index.js";
import { config } from "../config.js";
import { priceAndStore } from "../copilot/options.js";
import { runTurn } from "../copilot/turn.js";
import { CommandError, AppError, toErrorResponse } from "../errors.js";
import { NO_MODEL_CAPTION } from "../guardrail/fallback.js";
import { store } from "../store.js";
import { contractorCtx, parseBody } from "./http.js";

export function createCopilotRouter(): Router {
  const router = Router();

  // A turn: newline-delimited JSON, one `{ type, ... }` object per line as each stage completes,
  // always ending with `done`. Failures after the stream starts are `error` lines, not HTTP errors.
  router.post("/api/applications/:id/copilot/turns", async (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    const body = parseBody(TurnRequestSchema, req.body);

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // The turn runs to completion even if the client goes away: the audit log must hold all of it.
    const write = (line: StreamLine): void => {
      if (!res.writable || res.writableEnded) return;
      res.write(`${JSON.stringify(StreamLineSchema.parse(line))}\n`);
    };

    if (!config.copilotEnabled) {
      write({ type: "error", ...toErrorResponse(new AppError("copilot.disabled")).body });
      write({ type: "done", event_ids: [] });
    } else if (!config.hasLlmKey) {
      write({ type: "error", ...toErrorResponse(new AppError("llm.missing_key")).body });
      write({ type: "done", event_ids: [] });
    } else {
      await runTurn(ctx, body.text, write);
    }
    res.end();
  });

  // The button that needs no model: prices all three products from the application's requested
  // loan amount, stores an Options record with no explanation, and returns the `options` line.
  router.post("/api/applications/:id/copilot/payment-options", async (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    const amount = store.getApplication(req.params.id)?.fields.requested_loan_amount?.value;
    if (typeof amount !== "number") throw new CommandError(NO_MODEL_CAPTION, { status: 400 });

    const { _mock: _ignored, ...catalog } = await withMock(ctx, "catalog", "getCatalog", () =>
      services.catalog.getCatalog(),
    );
    const priced = await priceAndStore(ctx, { catalog, amount_arg: null, term_arg: null });
    res.json(priced.line);
  });

  return router;
}
