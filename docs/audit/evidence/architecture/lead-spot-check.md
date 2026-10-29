# Architecture: lead spot-check (2026-10-29)

| Claim | Re-checked by | Result |
| --- | --- | --- |
| ARCH-MED-004: follow-up figures are blocked without a recalculation | `followup-figures-blocked.ts` (number-match with no calculator values) | Blocked on $396.29 and 120 months. The prompt rule at copilot.system.md:45 confirmed |
| ARCH-MED-003: in-memory, process-local | Read store.ts:55, index.ts:19-22, single-flight.ts:8 | Confirmed |
| ARCH-MED-006: turn retry duplicates | Read turn.ts:136 and web conversation.ts:151 | Code confirmed. Not reproduced (needs a key and a dropped stream) |
| Only commands write the store | tests/commands.test.ts:612 exists | Confirmed. `npm test` not re-run |
