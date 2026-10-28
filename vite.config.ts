import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEFAULT_API_PORT = 3000;

/** The repository's .env. The config root is web/, so this is resolved from this file, not from the working directory. */
export const ROOT_ENV_FILE = fileURLToPath(new URL("./.env", import.meta.url));

/**
 * The port the API server listens on, for the dev proxy. The server reads PORT from the root .env
 * (the file wins over the shell), so the proxy does too: .env, then the shell, then 3000.
 */
export function resolveApiPort(envFile = ROOT_ENV_FILE, shellPort = process.env.PORT): number {
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")).PORT : undefined;
  for (const raw of [fromFile, shellPort]) {
    const port = Number(raw?.trim());
    if (raw?.trim() && Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return DEFAULT_API_PORT;
}

export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": `http://localhost:${resolveApiPort()}`,
    },
  },
});
