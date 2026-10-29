#!/usr/bin/env node
// Drives the built web app through a copilot conversation in a headless browser and saves a
// screenshot after every step, so a reviewer can see what the contractor and the homeowner saw.
// Needs the server running (`npm start`) and `playwright-core` resolvable (it is not a project
// dependency: `NODE_PATH=<dir with node_modules/playwright-core> node scripts/ui-walk.mjs`).
//
// Flags: --base <url> (default http://localhost:3000)  --app <id> (default app_demo_001)
//        --out <dir> (default ./ui-walk)  --turn "<text>" (repeatable; default: three turns)
//        --chrome <path> (default /usr/bin/google-chrome)  --timeout <ms> (default 120000)
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flags = (name) => args.flatMap((a, i) => (a === name && i + 1 < args.length ? [args[i + 1]] : []));

const base = flag("--base", "http://localhost:3000");
const appId = flag("--app", "app_demo_001");
const out = resolve(flag("--out", "./ui-walk"));
const chromePath = flag("--chrome", "/usr/bin/google-chrome");
const timeout = Number(flag("--timeout", "120000"));
const turns = flags("--turn");
if (turns.length === 0) {
  turns.push(
    "The project is $30K. What would the monthly payment look like?",
    "Will she be approved?",
    "Explain how the 0% option works.",
  );
}

mkdirSync(out, { recursive: true });
const log = [];
const note = (line) => {
  log.push(`${new Date().toISOString()} ${line}`);
  console.log(line);
};

let shot = 0;
async function snap(page, name) {
  shot += 1;
  const file = resolve(out, `${String(shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  note(`screenshot ${file}`);
}

async function step(name, fn) {
  try {
    await fn();
    note(`ok   ${name}`);
  } catch (error) {
    note(`FAIL ${name}: ${error.message.split("\n")[0]}`);
  }
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.setDefaultTimeout(timeout);
page.on("console", (m) => { if (m.type() === "error") note(`console.error ${m.text()}`); });
page.on("pageerror", (e) => note(`pageerror ${e.message}`));

await step("reset and load the demo", async () => {
  const headers = { "content-type": "application/json", "x-session-id": "ui-walk" };
  let r = await fetch(`${base}/api/reset`, { method: "POST", headers, body: "{}" });
  if (!r.ok) throw new Error(`reset ${r.status}`);
  r = await fetch(`${base}/api/applications/${appId}/load-demo`, { method: "POST", headers, body: "{}" });
  if (!r.ok) throw new Error(`load-demo ${r.status}`);
});

await step("open the contractor view", async () => {
  await page.goto(`${base}/applications/${appId}`, { waitUntil: "networkidle" });
  await snap(page, "contractor");
});

for (const [i, text] of turns.entries()) {
  await step(`turn ${i + 1}: ${text}`, async () => {
    const input = page.getByPlaceholder(/message the assistant/i);
    await input.fill(text);
    await page.getByRole("button", { name: /^send$/i }).click();
    // A status line (role="status") is shown while the turn streams; the turn is over once it
    // has appeared and gone again.
    await page.locator(".status-line").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector(".status-line"), null, { timeout });
    await page.waitForTimeout(800);
    await snap(page, `turn-${i + 1}`);
  });
}

await step("open the homeowner view", async () => {
  const button = page.getByRole("button", { name: /show homeowner view/i }).first();
  await button.waitFor({ state: "visible" });
  await button.click();
  await page.waitForURL(/homeowner/, { timeout });
  await page.waitForLoadState("networkidle");
  await snap(page, "homeowner");
});

await step("back to the application", async () => {
  await page.getByRole("link", { name: /back to application/i }).or(page.getByRole("button", { name: /back to application/i })).first().click();
  await page.waitForURL(new RegExp(`/applications/${appId}$`), { timeout });
  await page.waitForTimeout(500);
  await snap(page, "contractor-after");
});

await step("open the audit view", async () => {
  await page.goto(`${base}/audit/${appId}`, { waitUntil: "networkidle" });
  await snap(page, "audit");
});

await browser.close();
writeFileSync(resolve(out, "walk.log"), log.join("\n") + "\n");
note(`log ${resolve(out, "walk.log")}`);
