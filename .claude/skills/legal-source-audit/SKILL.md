---
name: legal-source-audit
description: Verify a database of tnved_checker (bans, licences, controls, ЕТТ rates, ТР lists, exemptions, quotas, НКС, TROIS…) against its official primary source, fix the data, and update SOURCE_AUDIT. Use for any "сверь с первоисточником", "проверь базу", "добавь перечень", "обнови по новой редакции" request.
---

# Legal source audit

Knowledge lives in the docs; this skill is only the order of work.

1. Read [docs/legal-sources.md](../../../docs/legal-sources.md) (registry APIs, WAF, portal sections, PDF/Word parsing traps) and [docs/source-audit.md](../../../docs/source-audit.md) (state of every record, mandatory post-import checks, resolved cases). Read [docs/base-architecture.md](../../../docs/base-architecture.md) for the database's shape (`findX`, prefix matching, `TNVED_MAP`, direction attributes).
2. Find the record in `SOURCE_AUDIT` (`server/private/base.js`) and the `DOC_SOURCES` key of the act. Note what the last check covered and what it left open.
3. Locate the **current** official text: cbd.minjust.gov.kg (`GetDocument` → `editions`, `documentReferences`), docs.eaeunion.org (year sections, `_att.zip`), the ЕЭК department page for consolidated lists, gov.kg/ru/npa for fresh Cabinet acts, online.toktom.kg as a trusted second source for Kyrgyz acts (the card links to cbd.minjust.gov.kg); CIS treaties from cbd.minjust.gov.kg only (cis.minsk.by is not used). Check the edition id and date; look for a restatement («изложить в следующей редакции») and for every amending act; read the act's own in-force clause, not the registry status label.
4. Parse the annex from real cell data (`.docx` tables, layout-mode PDF text); count the act's own numbering (1..N, no gaps) as the completeness proof.
5. Compare with the base as a **set**, both ways: codes per position, «из» marks, forms/documents per position, ranges expanded, exclusions; explain every difference by a specific amending act or treat it as an error.
6. Fix the data with an anchored Node-script edit of `base.js` (mixed line endings — `CLAUDE.md`, «Editing safety»). Store codes as the act writes them; a code absent from the ЕТТ gets a `TNVED_MAP` entry, not a silent rewrite; unconfirmed rows get `unver:true` and say so on the card. Only Kyrgyz national measures go into the base.
7. Run the post-import checks: length histogram of codes, duplicate keys inside each object literal, ЕТТ-prefix check, duplicates inside a code list, `parseRateInfo` over every changed rate.
8. Update the `SOURCE_AUDIT` record (date, scope, what remains open) and any `DOC_SOURCES` edition id **in the same commit**; never write a date for a check you did not perform.
9. Verify: `node --check` of the three big files, `git diff --numstat` and LF-only count against `HEAD`, runtime smoke test of the changed `findX()` through `require('./server/src/services/base').load()`, the relevant tests (`lookup-filter`, `direction-regime`, `engine`, `assistant` when cards changed), live cards for a few affected codes.
10. Append the session entry to `session.md` (what was read, edition ids, what changed, what is open); update `CURRENT.md` if an open issue closed or opened. Do not commit unless asked.
