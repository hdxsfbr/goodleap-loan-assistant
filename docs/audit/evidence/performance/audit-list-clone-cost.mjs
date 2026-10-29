// PERF-MED-007: what one audit.list() call costs. audit.list filters an application's events and
// structuredClones each one (server/audit-log.ts:175). This clones N independent copies of the
// events in an audit file (default data/audit.jsonl from a local run) and reports ms per call.
// Usage: node docs/audit/evidence/performance/audit-list-clone-cost.mjs [path/to/audit.jsonl]
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2] ?? "data/audit.jsonl", "utf8").trim().split("\n");
const bytes = {};
for (const line of lines) { const e = JSON.parse(line); bytes[e.type] = (bytes[e.type] ?? 0) + line.length; }
console.log(`${lines.length} events, ${lines.reduce((t, l) => t + l.length, 0)} bytes; largest types:`,
  Object.entries(bytes).sort((a, b) => b[1] - a[1]).slice(0, 3));
for (const copies of [1, 10, 40]) {
  const events = [];
  for (let k = 0; k < copies; k++) for (const line of lines) events.push(JSON.parse(line));
  const started = performance.now();
  for (let i = 0; i < 10; i++) events.map((e) => structuredClone(e));
  console.log(`${events.length} events: ${((performance.now() - started) / 10).toFixed(1)} ms per audit.list()`);
}
