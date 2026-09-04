# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is **not** a conventional software project — it's a working folder for building and maintaining a single deliverable:

- **`tnved_checker.html`** — a self-contained, single-file web app ("Проверка ТН ВЭД — КР 2025/2026") for checking Kyrgyz Republic / EAEU customs (ТН ВЭД) codes against import/export bans, licensing, certification, veterinary/phytosanitary/sanitary control, technical regulations, export control (dual-use/NKS), duty rates, and more. No build step, no package manager, no framework — pure HTML + inline `<style>` + one inline `<script>`, ~8 MB, almost entirely legal/customs reference data hard-coded as JS constants.
- The rest of the repo is **source material**: official legal texts (`.md` files — tax code, Единый перечень, government resolutions, etc.) that get manually parsed and encoded into the app, and **`session.md`**, a running Russian-language changelog of what was done, why, and what's still unverified. There is no git history — `session.md` is the only record of past work, so append to it (or ask the user how they want it tracked) when you make a substantive change.

There are no other services, no server code, no CI. "Running" the app means opening `tnved_checker.html` in a browser.

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

**Browser check** (for UI/rendering changes): no browser is preinstalled for automation. Prior sessions installed `playwright-core` into a temp folder and drove the system Microsoft Edge via `channel:'msedge'` (no browser download needed).

## Architecture

### One file, one pattern, repeated ~25 times

Nearly the entire script is variations on: **one `SCREAMING_SNAKE_CASE` const holding a legal database, one `findX(query)` function that looks a code up in it, one block in the central `render()` that turns a hit into a result card.** Examples: `BAN_DB`/`findBan`, `VET_DB`/`findVET`, `PHYTO_DB`/`findPHYTO`, `TR_EAEU_DB`/`findTREAEU`, `ETT_DB`/`findETT`, `SPECIES_DB`/`findSpecies`, `NTM_DB`/`findEEC30`, `SAN_SECTIONS`/`SAN_REG_DB`/`SAN_SUB_DB`/`SAN_SECTION3`/`findSAN`, etc. When adding a new legal source, follow this same triplet rather than inventing a new shape.

`render(q)` (search for `function render(q)`) is the dispatcher for the default "search by code" mode: it calls essentially every `findX(qt)` in one shot, and if every result is empty shows a "not found" card; otherwise it concatenates one `<div class="card c-...">` block per non-empty result type, in a fixed order. Other search modes (`renderAuto`, `renderVIN`, `renderSpecies`, `renderByName`, `renderCalcSearch`) are separate, self-contained pipelines wired up by `setSearchMode()` and dispatched from the single debounced `#inp` input listener near the end of the script based on the current `searchMode`.

### Two-tier export-control (NKS) data — a known trap

`NKS` (a flat `Set` of ~1,200 bare code strings) is the list that actually drives search results (`findNKS` iterates it). `NKS_ITCAT` (an object keyed by code → `[name, section, icon]`) exists only to give `nksCat()` a nicer label when one is available, falling back to coarse chapter-based heuristics otherwise. **`NKS_ITCAT` is a subset of `NKS`.** Adding a code to only one of the two will make it either invisible in search (added to `NKS_ITCAT` only) or correctly found but poorly labeled (added to `NKS` only) — new NKS entries need both.

### Citations: `DOC_SOURCES` + `docLink()`

`DOC_SOURCES` is a registry of verified `{key: url}` pairs to primary sources (docs.eaeunion.org for EAEU Board/Council decisions, cbd.minjust.gov.kg for Kyrgyz government acts). `docLink(label, url)` renders a real `<a>` when `url` is truthy, otherwise falls back to plain escaped text — **never invent a URL to fill this in**; if a primary source can't be confirmed, leave the citation as plain text (this convention is explicit and intentional, see `session.md`). `NPA_REGISTRY_URL` is the generic fallback link to the Kyrgyz Кабмин NPA registry, used when a specific act can't be pinned down.

### Verifying legal text against primary sources

`cbd.minjust.gov.kg` is a React SPA — don't try to scrape it as static HTML. It has an undocumented JSON API instead:
- `POST /api/v1/GetDocuments` with `{"number":..., "dateAdoptedFrom":..., "dateAdoptedTo":...}` to find a document's `documentCode` and current `lastEdition` id.
- `GET /api/v1/GetEdition?editionId=<id>&lang=ru` returns the full text (`contentRu`, a Word-export HTML blob) and its date (`nameRus`).
- The public document URL pattern is `https://cbd.minjust.gov.kg/<documentCode>/edition/<editionId>/ru`.
- The WAF blocks any POST body containing raw (UTF-8) Cyrillic bytes regardless of field name — encode the JSON body with `ensure_ascii=True` (`\uXXXX` escapes) to get through.
- For EAEU-level acts (Решения Коллегии/Совета ЕЭК), prefer `docs.eaeunion.org` — do not guess a URL by pattern-matching a neighboring document's numbering; two similarly-numbered documents there can point to completely unrelated acts.

### Editing the large data literals

Several DB constants are single lines hundreds of KB long (the whole `NKS_ITCAT` object or `NKS` array can be one line). The `Edit` tool is unreliable at that size — prior sessions insert/remove entries with a small Python/Node script that does a targeted, anchor-based string replacement on the raw file text (confirm `content.count(anchor) == 1` before replacing, to avoid silently touching the wrong occurrence), then re-run the syntax check and a runtime smoke test. Bulk table data pulled from a fetched legal text is parsed out separately (regex over the stripped-HTML text, watching for CAS-number/ISO-number/range-reference collisions eating adjacent real codes) before being spliced in the same way.
