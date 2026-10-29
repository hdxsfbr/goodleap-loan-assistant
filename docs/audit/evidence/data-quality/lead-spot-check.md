# Data quality: lead spot-check (2026-10-29)

| Claim | Re-checked by | Result |
| --- | --- | --- |
| DQ-MED-011: single-period annualization | Read shared/document-schemas/pay_stub.ts:65-67 | Confirmed (52/26/24/12; ±10% or $5,000) |
| PRE-003: a multi-token word breaks `findRun` | Read pdfjs.ts:46 (`\S+` split) and shared/normalize.ts `normalizeToken` | Refuted |
