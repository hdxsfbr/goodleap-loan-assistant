import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { createApiRouter } from "./api/index.js";
import { createAuditLog, createFileSink, installAuditLog } from "./audit-log.js";
import { config } from "./config.js";
import { loadEnvFile } from "./load-env.js";
import { UPLOADS_DIR } from "./services/documents/mock.js";
import { store } from "./store.js";
import { getVersions } from "./versions.js";

// Process entry and composition root. Configuration is read lazily (server/config.ts), so loading
// .env here, after the static imports above have been evaluated, is early enough. Values in .env
// override variables the shell already exports; with no .env file the app starts without a key.
loadEnvFile();

mkdirSync("data", { recursive: true });
// Attached files belong to the in-memory records of the run that took them, like the audit file.
rmSync(UPLOADS_DIR, { recursive: true, force: true });
mkdirSync(UPLOADS_DIR, { recursive: true });
installAuditLog(createAuditLog(createFileSink("data/audit.jsonl", { truncate: true })));
store.loadSeed();

const app = express();
app.disable("x-powered-by");
app.use(createApiRouter());

// The built web app, when it exists: static files plus the history fallback (Express 5 syntax).
if (existsSync("dist/web")) {
  const webRoot = resolve("dist/web");
  app.use(express.static(webRoot));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(resolve(webRoot, "index.html"));
  });
}

const port = config.port;
const server = app.listen(port, () => {
  console.log(`GoodLeap loan assistant listening on http://localhost:${port}`);
  console.log(`LLM key present: ${config.hasLlmKey}${config.llmBaseUrl ? ` (base URL ${config.llmBaseUrl})` : ""}`);
  console.log("Versions:", JSON.stringify(getVersions()));
});
server.on("error", (err) => {
  console.error(`Could not start the server on port ${port}:`, err.message);
  process.exit(1);
});
