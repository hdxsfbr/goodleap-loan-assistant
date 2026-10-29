import { beforeEach, describe, expect, it } from "vitest";
import type { StreamLine } from "@shared/schemas";
import { createAuditLog, createMemorySink, installAuditLog, type Ctx } from "../server/audit-log.js";
import { runTurn } from "../server/copilot/turn.js";
import { LIKELIHOOD_WORDS, OUT_OF_SCOPE_ACTIONS, OUT_OF_SCOPE_REPLY } from "../server/guardrail/fallback.js";
import { setClientForTests } from "../server/llm/client.js";
import { store } from "../server/store.js";

// Item 81: the out-of-scope reply is a prompt rule, so this test needs the model. It makes one
// real call (plus the judge's) when ANTHROPIC_API_KEY is set, and is skipped with a printed
// reason when it is not.

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
if (!hasKey) console.log("tests/out-of-scope-reply.test.ts: skipped, ANTHROPIC_API_KEY is not set (add it to .env).");

const ctx: Ctx = {
  application_id: "app_demo_001",
  session_id: "out-of-scope-test",
  actor: { type: "contractor", id: "ctr_demo_001" },
};

/** Typographic apostrophes and spacing must not decide the comparison. */
const plain = (text: string): string =>
  text.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

describe.skipIf(!hasKey)("out-of-scope reply (needs ANTHROPIC_API_KEY)", () => {
  beforeEach(() => {
    setClientForTests(undefined);
    store.reset();
    store.loadSeed();
    installAuditLog(createAuditLog(createMemorySink()));
  });

  it("answers an approval question with the fixed reply and the two offers, without likelihood words", async () => {
    const lines: StreamLine[] = [];
    await runTurn(ctx, "Will she be approved?", (line) => lines.push(line));

    const types = lines.map((line) => line.type);
    expect(types).not.toContain("error");
    expect(types).not.toContain("fallback");
    expect(types).not.toContain("options");
    expect(types.at(-1)).toBe("done");

    const explanation = lines.find((line) => line.type === "explanation");
    expect(explanation?.type).toBe("explanation");
    const reply = plain(explanation?.type === "explanation" ? explanation.text : "");

    expect(reply).toContain(plain(OUT_OF_SCOPE_REPLY));
    for (const action of OUT_OF_SCOPE_ACTIONS) expect(reply).toContain(plain(action));
    for (const word of LIKELIHOOD_WORDS) {
      expect(reply, `the reply must not contain "${word}"`).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
  }, 90_000);
});
