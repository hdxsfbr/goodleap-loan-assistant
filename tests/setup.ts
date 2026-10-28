// Runs before every test file. Loads .env when it exists, overriding the shell like the server
// does, so a test that needs ANTHROPIC_API_KEY finds it; such a test skips with a printed reason
// when the variable is absent.
import { loadEnvFile } from "../server/load-env.js";

loadEnvFile();
