import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Loads a `.env` file into `process.env`, and the file wins: every entry replaces a variable of the
 * same name that the shell already exported. Returns false, and changes nothing, when the file does
 * not exist. Used by the server entry and by the test setup so both read the same configuration.
 */
export function loadEnvFile(path = ".env"): boolean {
  if (!existsSync(path)) return false;
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (value !== undefined) process.env[name] = value;
  }
  return true;
}
