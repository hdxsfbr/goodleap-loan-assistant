# Security: lead spot-check (2026-10-29, commit 35eb9af)

| Claim | Re-checked by | Result |
| --- | --- | --- |
| SEC-HIGH-001: an anonymous reviewer write is recorded as `rev_demo_001` | `anonymous-reviewer-and-reset.sh` against a keyless server on :3471 | Confirmed: actor reviewer/rev_demo_001, session `no-session` (`.out`) |
| SEC-MED-002: an anonymous reset empties the audit | Same script | Confirmed: 41 events to 0 |
| SEC-MED-005: confirm-all takes no ids | Read server/api/applications.ts:196-202 and web ApplicationForm.tsx:91 | Code confirmed. The race was not reproduced |
