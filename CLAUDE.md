# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is **not** a conventional software project — it's a working folder for building and maintaining a single deliverable:

- **`tnved_checker.html`** — a self-contained, single-file web app ("Проверка ТН ВЭД — КР 2025/2026") for checking Kyrgyz Republic / EAEU customs (ТН ВЭД) codes against import/export bans, licensing, certification, veterinary/phytosanitary/sanitary control, technical regulations, export control (dual-use/NKS), duty rates, and more. No build step, no package manager, no framework — pure HTML + inline `<style>` + one inline `<script>`, ~8 MB, almost entirely legal/customs reference data hard-coded as JS constants.
- **`server/`** — a small Node/Express + PostgreSQL backend added in the "accounts/admin" phase, providing real (server-verified) login and an admin panel for creating/editing/disabling user accounts. See "Backend (`server/`)" below.
- The rest of the repo is **source material**: official legal texts (`.md` files — tax code, Единый перечень, government resolutions, etc.) that get manually parsed and encoded into the app, and **`session.md`**, a running Russian-language changelog of what was done, why, and what's still unverified. `session.md` remains the narrative record of past work — why something was done and what is still unverified — so append to it when you make a substantive change. Since the review of 05.09.2026 the repo also has **real git history** (it previously had none): commit `eade5b8` preserves the working set as it had been staged, including 15 legal source `.md` files that by then existed only in the git index and not on disk. Those files are recoverable with `git checkout eade5b8 -- <path>` if they are ever needed again. There is still no remote, so history is local-only and is a rollback path, not a backup.

**`.gitattributes` sets `* -text` and must stay that way.** `tnved_checker.html` is ~11 MB with *mixed* line endings (some large one-line data literals contain CRLF inside them), and every edit to it is an anchored exact-string replacement. Git's `core.autocrlf` would rewrite those bytes on checkout, breaking anchors and producing a whole-file phantom diff. This was caught during the review: the first attempt at committing the file silently stripped 7,466 CR bytes.

Beyond `server/`, there is no other service and no CI. "Running" `tnved_checker.html` alone by double-clicking it (`file://`) no longer works end-to-end: the file now gates its UI behind a login screen that calls `/api/auth/*`, so it needs to be served over http(s) from the same origin as the backend (Nginx serving the static file + proxying `/api/*` to `server/` in production; `server/`'s own `express.static` fallback for local dev — see below). The underlying legal-data constants are still fully embedded in the page source either way (nothing moved server-side in this phase), so the login gate controls who can *use* the tool, not who can view its bundled reference data via "view source."

## Commands

There is no build/lint/test tooling. The workflows that stand in for them, established over prior sessions:

**Syntax-check the inline script** (the file is too large for editors/tools to just "open and check"; do this after every edit):
```bash
python3 -c "
import re
content = open('tnved_checker.html', encoding='utf-8').read()
m = re.search(r'<script>(.*)</script>', content, re.S)
open('/tmp/inline_script.js', 'w', encoding='utf-8').write(m.group(1))
"
node --check /tmp/inline_script.js
```
Note: `python3` here resolves to the Windows Store alias, which does **not** see git-bash POSIX paths like `/tmp/...` — write scratch files to a Windows-style path (or the session scratchpad dir) instead, and read them back with the `Read` tool, not by printing to the bash console (the console mangles Cyrillic output; files round-trip correctly).

**Runtime smoke-test** a function or DB after editing it: extract the inline script as above, then run it inside a Node `vm` context with minimal DOM stubs (`document.getElementById`, `classList`, `innerHTML`/`value`/`textContent` getters/setters, etc. — the top-level script calls a few `render*Panel` functions immediately on load, so it throws without stubs). Expose the globals you need via `this.__x = x;` appended to the script source before `runInContext`, since top-level `const`/`let` in a vm context aren't reliably visible as properties of the sandbox object otherwise. This is how new/changed lookup functions and DB entries get verified end-to-end without a browser.

**Browser check** (for UI/rendering changes): no browser is preinstalled for automation. Prior sessions installed `playwright-core` into a temp folder and drove the system Microsoft Edge via `channel:'msedge'` (no browser download needed). Since `tnved_checker.html` now requires a backend to get past its login screen, point this at a running instance of `server/` (local or the real VPS deploy) rather than a bare `file://` path — opening the file directly still renders the login screen (confirms the UI didn't break), but every `fetch('/api/...')` call fails immediately with a CORS/network error under `file://`, so nothing past the login screen is reachable that way.

## Backend (`server/`)

A small Express + PostgreSQL app providing session-based login and an admin API (`/api/auth/*`, `/api/admin/*`) for `tnved_checker.html`. See the plan at the time it was added for the full design rationale (RLS-equivalent access model, why sessions instead of JWT, CSRF approach, etc.) — this section just covers day-to-day commands.

**Local dev:**
```bash
cd server
npm install
cp .env.example .env   # fill in DATABASE_URL (a local Postgres) and SESSION_SECRET
psql "$DATABASE_URL" -f migrations/0001_init.sql
npm run create-admin -- you@example.com "some-password"   # one-off first admin
npm run dev
```
`server/src/index.js` also serves `tnved_checker.html` itself (via `express.static`, pointed at the repo root) so `http://localhost:3000/` works standalone for local testing without Nginx in front.

**Deploy (VPS):** install Node LTS + PostgreSQL, create the DB/role and apply `migrations/0001_init.sql`, deploy `server/` and run `npm ci --omit=dev`, run `create-first-admin.js` once, run the app under a systemd unit (`ExecStart=node server/src/index.js`, `EnvironmentFile=` pointing at a production `.env`), and put Nginx in front: serve `tnved_checker.html` as static content at `/`, reverse-proxy `location /api/ { proxy_pass http://127.0.0.1:3000; }`, and terminate TLS there (Let's Encrypt via `certbot --nginx`, which needs a real domain pointed at the VPS — a bare IP can't get a cert).

**Schema/migrations:** there's no migration framework — `migrations/*.sql` files are applied by hand with `psql -f`, in order, once each. Add new migrations as new numbered files rather than editing an already-applied one.

## Mobile wrapper (`mobile/`)

A thin Capacitor shell (`kg.tnved.checker`) for Android and iOS. It ships no copy of the app: `capacitor.config.json` sets `server.url` to the production origin, so the WebView simply loads the deployed site and every `/api/*` call is same-origin. Two consequences worth remembering:

- Tightening anything origin-related on the backend is safe for the app, because the WebView's `Origin` is exactly `APP_ORIGIN`. That is what made the CSRF check in `server/src/index.js` safe to make fail-closed.
- Changing `server.url` means rebuilding and re-releasing the app, so the production origin is effectively pinned by the store listings.

`privacy.html` at the repo root is deliberately *not* linked from the app (which shows its policy in a modal). It exists as a standalone, publicly reachable URL because app-store review requires one that works without logging in.

Builds run in Codemagic (`mobile/codemagic.yaml`); `mobile/android/local.properties` and both `node_modules` are gitignored.

## Architecture

### One file, one pattern, repeated ~25 times

Nearly the entire script is variations on: **one `SCREAMING_SNAKE_CASE` const holding a legal database, one `findX(query)` function that looks a code up in it, one block in the central `render()` that turns a hit into a result card.** Examples: `BAN_DB`/`findBan`, `VET_DB`/`findVET`, `PHYTO_DB`/`findPHYTO`, `TR_EAEU_DB`/`findTREAEU`, `ETT_DB`/`findETT`, `SPECIES_DB`/`findSpecies`, `NTM_DB`/`findEEC30`, `SAN_SECTIONS`/`SAN_REG_DB`/`SAN_SUB_DB`/`SAN_SECTION3`/`findSAN`, etc. When adding a new legal source, follow this same triplet rather than inventing a new shape.

`render(q)` (search for `function render(q)`) is the dispatcher for the default "search by code" mode: it calls essentially every `findX(qt)` in one shot, and if every result is empty shows a "not found" card; otherwise it concatenates one `<div class="card c-...">` block per non-empty result type, in a fixed order. If nothing matches by code, `render()` itself falls back to a name-based match (`findByName`/`nameMatchesHtml`) rather than that being a separate mode. The two other search modes still wired up by `setSearchMode()` and dispatched from the single debounced `#inp` input listener are `renderSpecies` and `renderCalcSearch`; a former VIN-lookup mode (`renderVIN`/`findVIN`) and a manual "Авто" text-search mode (`renderAuto`/`findAuto`) were both removed as dead code (see session.md, 28.08.2026 and 30.08.2026 entries) — don't resurrect those names expecting them to still exist.

### Two-tier export-control (NKS) data — a known trap

`NKS` (a flat `Set` of ~1,200 bare code strings) is the list that actually drives search results (`findNKS` iterates it). `NKS_ITCAT` (an object keyed by code → `[name, section, icon]`) exists only to give `nksCat()` a nicer label when one is available, falling back to coarse chapter-based heuristics otherwise. **`NKS_ITCAT` is a subset of `NKS`.** Adding a code to only one of the two will make it either invisible in search (added to `NKS_ITCAT` only) or correctly found but poorly labeled (added to `NKS` only) — new NKS entries need both.

### Legacy nomenclature: acts are transcribed verbatim, never renumbered

Several databases are literal transcriptions of legal acts — `NKS` from Постановление КМ КР №63 от 10.02.2023, `ETT_UAE_DB` and `ETT_RS_DB` from the annexes to the EAEU–UAE and EAEU–Serbia agreements. The ТН ВЭД nomenclature has changed since those acts were signed: subheadings were renumbered (2845 90 900 0 became 2845 90 800 0) and split (HS2022 broke 8701 20 into 8701 21…8701 29). Because every `findX()` matches on a digit prefix, those entries were unreachable from a current code — the review of 05.09.2026 measured 140 such codes in `NKS`, 41 in `ETT_UAE_DB` and 38 in `ETT_RS_DB`, all of which made the app answer "nothing found" rather than warn.

**Do not "fix" this by rewriting the codes to their current equivalents.** These are transcriptions of legal text, there is no official correlation table in the project, and a guessed mapping in a customs compliance tool is worse than a gap. Instead the file computes the gap at runtime: `legacyPrefix()` asks whether a code has any counterpart in `ETT_DB` and, if not, returns the deepest prefix that still exists (10→8→6→4 digits); `legacyMapFor()` caches one such map per database, keyed by the code exactly as that database spells it. A match found only through that fallback is flagged and the card renders an explicit "verify applicability" warning naming the act's original code and the level at which it matched.

If you add another act-transcribed database, reuse `legacyMapFor()` rather than inventing a second mechanism, and think about which direction the risk runs. Over-matching is safe for export control (`NKS`) and for the Serbia exclusion list, where a miss wrongly implies "no restriction"; it is *not* safe for the UAE rate schedule, where a spurious match implies a preference the declarant may not be entitled to, so that card's wording is deliberately harsher. Keep the fallback iterating the small legacy map, never the whole database — the first draft scanned all 7,917 UAE rows on every keystroke and made search five times slower.

### Citations: `DOC_SOURCES` + `docLink()`

`DOC_SOURCES` is a registry of verified `{key: url}` pairs to primary sources (docs.eaeunion.org for EAEU Board/Council decisions, cbd.minjust.gov.kg for Kyrgyz government acts). `docLink(label, url)` renders a real `<a>` when `url` is truthy, otherwise falls back to plain escaped text — **never invent a URL to fill this in**; if a primary source can't be confirmed, leave the citation as plain text (this convention is explicit and intentional, see `session.md`). `NPA_REGISTRY_URL` is the generic fallback link to the Kyrgyz Кабмин NPA registry, used when a specific act can't be pinned down.

Not every citation goes through `docLink()`, though — several DB entries carry their act reference inline inside a `name`/`note` field that `render()` only ever passes through `esc()` (e.g. `NTM_DB` notes, `SAN_REG_DB` exclusion names). Restructuring `render()` just to wire one more field through `docLink()` is usually not worth it. In that case, once a URL is verified, just paste it as plain readable text directly into the `name`/`note` string itself — it renders as inert but legible text, which is consistent with the project's existing precedent and cheaper than plumbing a new field through the render pipeline.

### Verifying legal text against primary sources

`cbd.minjust.gov.kg` is a React SPA — don't try to scrape it as static HTML. It has an undocumented JSON API instead:
- `POST /api/v1/GetDocuments` with `{"number":..., "dateAdoptedFrom":..., "dateAdoptedTo":...}` to find a document's `documentCode` and current `lastEdition` id.
- `GET /api/v1/GetEdition?editionId=<id>&lang=ru` returns the full text (`contentRu`, a Word-export HTML blob) and its date (`nameRus`).
- The public document URL pattern is `https://cbd.minjust.gov.kg/<documentCode>/edition/<editionId>/ru`.
- The WAF blocks any POST body containing raw (UTF-8) Cyrillic bytes regardless of field name — encode the JSON body with `ensure_ascii=True` (`\uXXXX` escapes) to get through.
- The WAF also blocks plain `GET /api/v1/GetEdition` requests that look like a bare script (no browser-like headers) — add `User-Agent` and `Referer: https://cbd.minjust.gov.kg/<documentCode>/edition/<editionId>/ru` to get a 200 instead of 403.
- For EAEU-level acts (Решения Коллегии/Совета ЕЭК), prefer `docs.eaeunion.org` — do not guess a URL by pattern-matching a neighboring document's numbering; two similarly-numbered documents there can point to completely unrelated acts.
- For EAEU Commission department-level technical/sanitary annexes (e.g. Единые санитарные требования under Решение №299) that aren't single consolidated acts, check `eec.eaeunion.org/comission/department/<dept>/regulation/...` (e.g. `depsanmer` for sanitary measures) — these pages link directly to per-section PDFs at `eec.eaeunion.org/upload/files/<dept>/.../раздел N ЕСТ.pdf`-style URLs (URL-encode the Cyrillic filename). No special headers needed here, unlike cbd.minjust.gov.kg. Fetch with `curl`/Bash and extract text with the `pypdf` package (`PdfReader(path).pages[i].extract_text()`), which is already available in this environment — don't rely on WebFetch's summarizing model for a legal code table, since digit-level transcription errors there are invisible until they cause a wrong lookup.
- `cbd.minjust.gov.kg`'s `GetDocuments` search-by-number can silently return the wrong act: Kyrgyz act numbering is not unique across act types within the same year (a «Постановление» and a «Распоряжение» — or a presidential «Указ» — can share the same number), so a number+date match still needs its `vid`/`organ`/`nameRu` fields checked against what you're actually looking for before you trust it — don't assume a hit is correct just because the number and rough date line up.
- `GetDocuments`'s full-text search (`searchByTextRu`) appears to cap at a small batch of results (~10-17) even when the response's own `totalResultsCount` reports far more, and adding `length`/`pageSize`/`start` params doesn't change this — so don't rely on requesting "more" results; narrow the search phrase itself (longer, more distinctive substrings from the act's actual wording) until the specific act you want lands inside that small returned batch.
- A `GetDocuments` search that finds nothing for a very recently signed act (within roughly the last one to two weeks) is not proof the act doesn't exist — the registry appears to lag real-world signing by that long before indexing. Say so explicitly ("not yet indexed, unconfirmed") rather than treating an empty result as a negative finding.
- `docs.eaeunion.org`'s own search/portal poorly indexes older EAEU Council/Board decisions generally — this isn't limited to the pre-2013 acts noted above; a 2020 decision has also come up unfindable there. Treat any docs.eaeunion.org "not found" as inconclusive rather than as confirmation the act lacks a portal page, and don't burn excessive effort re-trying the same search phrasing once eec.eaeunion.org and independent cross-checked secondary sources have already been exhausted.
- A code extracted from an official PDF sometimes has fewer digits than the file's own DB entry (e.g. source says "8421 39 200", DB has `8421392000`; source says "8716 39 800", DB has `8716398000`) — don't assume this is a PDF-extraction artifact (a dropped trailing zero) without checking. Confirm one way or the other by (a) checking whether the shorter form recurs multiple times in continuous prose across independent documents (a real, deliberately-shortened conventional reference) vs. appearing once inside a table cell (more likely a layout-driven truncation), and (b) checking whether the longer, fully-qualified code actually exists as a real current tariff line — search this file's own `ETT_DB` first, then a tariff aggregator (alta.ru, tks.ru, kodtnved.ru, tws.by). If the long code is real and in active use, keep it; if no such code exists anywhere, truncate the DB entry to the shorter, confirmed subheading-level code instead of leaving an unreachable one in place.

### Conflicting matches within one `findX()` — most-specific-code-wins

Several `findX()` functions match by prefix (`cn.startsWith(qn)||qn.startsWith(cn)`), which lets a query simultaneously hit both a broad, generic-level entry (e.g. a whole heading `2915`) and a narrow, more specific one nested inside it (e.g. an exclusion for exact code `2915120000`) that's meant to override it. Left unhandled, `render()` shows both cards at once with contradictory messages (e.g. "registration required" next to "registration not required" for the same code). `findSAN()` (near `SAN_REG_DB`) solves this by computing, per candidate match, the length of its longest code that is actually a prefix of the query (i.e. genuinely applicable to this specific query, not just "contains a longer code somewhere"), then keeping only the matches tied for the maximum such length — so a more specific hit suppresses a more generic one, but a bare/short query (shorter than any candidate code) isn't wrongly reduced to nothing. If you add a new DB where a specific entry is meant to carve an exception out of a broader one, replicate this pattern in that `findX()` rather than trying to patch it in `render()`.

### Editing the large data literals

Several DB constants are single lines hundreds of KB long (the whole `NKS_ITCAT` object or `NKS` array can be one line). The `Edit` tool is unreliable at that size — prior sessions insert/remove entries with a small Python/Node script that does a targeted, anchor-based string replacement on the raw file text (confirm `content.count(anchor) == 1` before replacing, to avoid silently touching the wrong occurrence), then re-run the syntax check and a runtime smoke test. Bulk table data pulled from a fetched legal text is parsed out separately (regex over the stripped-HTML text, watching for CAS-number/ISO-number/range-reference collisions eating adjacent real codes) before being spliced in the same way.

**Relabeling many existing entries in an object literal** (e.g. correcting hundreds of `NKS_ITCAT` codes that were categorized under an old/generic label and should say something more specific): don't do hundreds of scattered surgical replacements across an 8 MB single-line file. Instead, just append new `"code":[...]` entries with the *same keys* to the end of the object literal, right before its closing `};` — a JS object literal lets a later duplicate key silently override an earlier one, so the new label wins at lookup time while the old entry stays physically in the file, inert. Much safer than editing hundreds of scattered locations, at the cost of some dead weight in the file.

**Parsing a Word-exported HTML table** (the `contentRu`/`contentKg` blobs from cbd.minjust.gov.kg, or any `.docx`→HTML dump): these tables routinely omit closing `</tr>`/`</td>` tags, relying on the next opening tag to implicitly close the previous one — feeding this to `html.parser.HTMLParser` naively produces empty cells, because nothing ever calls `handle_endtag`. Write the parser to close the current cell/row explicitly inside `handle_starttag` whenever a new `<td>`/`<tr>` opens (in addition to on the real end tag), not just in `handle_endtag`. Also watch for tables nested inside a note/example cell (e.g. a materials-compatibility reference table embedded in a "Примечание") — they show up as extra `<table>` elements in sequence; since they generally lack a code column, they're harmless to include in the row stream as long as downstream row-classification filters on the expected item-number pattern (e.g. `^\d+(\.\d+)+\.?$`), which such nested tables' first cells won't match.
