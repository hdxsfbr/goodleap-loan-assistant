// ARCH-MED-004: a follow-up turn that quotes an earlier turn's payment without calling
// calculate_payment again. turn.ts:188 passes no calculator values when the turn made no
// calculation, so number-match blocks the figure.
// Usage: npx tsx --tsconfig tsconfig.server.json docs/audit/evidence/architecture/followup-figures-blocked.ts
import { checkNumberMatch } from "../../../../server/guardrail/number-match.js";

const draft = "Option A stays at $396.29 a month for 120 months, so it is the predictable choice.";
console.log(JSON.stringify(checkNumberMatch(draft, { calculator_values: [], contractor_figures: [] })));
