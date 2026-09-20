---
name: ai-assistant-review
description: Audit or improve the AI assistant of tnved_checker — tool definitions (search_base, calc_payments, sum_check, group_notes), prompt, answer validation (codes, numbers, links), invoice/PDF/image reading (pdf.js, three readings, Vision, Document AI), hallucination traps, costs and limits, regression prompts. Use for "прогони помощника", "помощник ошибся", "улучши ответы AI", "проверь чтение инвойса".
---

# AI assistant review

The one rule above all others: **whatever can be enforced on the server is enforced there, never asked for in the prompt.**

1. Read [docs/ai-assistant.md](../../../docs/ai-assistant.md) whole — it records what has already been tried, measured and rejected. Then `server/src/services/assistant.js`, `routes/assistant.js`, `src/assistant-prompt.md` and `tests/assistant.test.js`.
2. Reproduce the case with saved steps where possible (tool inputs/outputs from the journal or a live run) before changing anything; separate a reading error (transcription of the page) from a reasoning error (calculation, retelling) from a data gap (the base did not know the country/code).
3. For a reading problem: check which path the page took (text layer, image, OCR layer), the orientation decision (Vision votes), the three readings and `reconcileReadings`/`reconcileWords`, `pageUnreliable`, and whether Document AI was called; measure on real pages, in several runs.
4. For a reasoning problem: prefer a deterministic fix in the tool output or in the answer validation (`unknownNumbers`, code checks, `totalUnknown`, `numberKnown`, `partialCalc`, `DSML_RE`) over a prompt sentence; keep the prompt short (it is paid on every round).
5. For a data problem: fix the base (see the legal-source-audit skill) — the assistant reads the same `renderHtml()` cards.
6. Guard the things that break silently: `tool_choice` forcing on the first round, `thinking` disabled, the 40 000-character output cap (do not lower without measuring), NDJSON streaming and the Nginx timeouts, `inFlight` per user, plan limits and the billing report, `roundCost` per round.
7. Verify: `assistant.test.js` (offline), `assistant-browser.test.js` (real PDFs under the site's CSP), then a live run on the server with `assistant-eval.js [filter]` and **read the answers**, over more than one run; record cost and results in `session.md`.
8. If a new third party or a new kind of stored data appears, update `privacy.html` and `ai-risk.json` in the same commit.
