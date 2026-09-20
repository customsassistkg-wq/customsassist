# CustomsAssistKG — Current State

Short, current, replaceable. Long-term rules go to `CLAUDE.md`/`docs/`, history goes to `session.md`; this file keeps only what is true now. Written 20.09.2026 from the code, `CLAUDE.md`, the last entries of `session.md` and the git log.

## Current architecture

- `tnved_checker.html` — markup, styles, login screen; served by Nginx at `https://customsassist.trade`. Holds no data.
- `server/private/base.js` (~12 MB) — every legal database and every `findX()`, `renderHtml`, `calcWarnings`, `lkPrefRates`, `BATCH_REQS`…, ending in `ENGINE_API`. **Server only.**
- `server/private/checker.js` (~330 KB) — the interface (pages, calculators, card post-processing, assistant page, admin panel); served only through `/api/checker.js` to a verified, signed-in user; asks the base through `engine()` → `POST /api/engine` (per-account enumeration limits).
- `server/` — Express + PostgreSQL (sessions, admin, email verification, Turnstile, terms acceptance, engine route, НБКР rates, class-decisions cache, AI assistant). Node listens on `127.0.0.1:3000` behind Nginx (TLS by Let's Encrypt).
- AI assistant — DeepSeek (Anthropic-compatible API) with server-side tools built on the base; documents read at attach time (pdf.js in the browser, three model readings reconciled with Google Cloud Vision; Google Document AI only on disagreement, on Google's stable version, no custom version deployed).
- `mobile/` — Capacitor shell over the live site; the site is also installable as a PWA.
- `assets/` — every image the site serves (page backgrounds and logos, mail logo, `assets/icons/` for the PWA), referenced as `/assets/…`; `assets/source/` holds the owner's originals for the generators in `tools/` and is never deployed.

## Current production state

- Site live at `https://customsassist.trade` (VPS 65.109.170.170, Hetzner Helsinki; `ts.customsassist.trade` is a different project on another server).
- Last deploy recorded in `session.md`: 18.09.2026, `/root/deploy_backups/20260918_191311/` — `services/assistant.js` of commit `5397775`. **No deploy is recorded for the `base.js`/`checker.js` changes of the direction-regime audit (`583b168`, `5a2dc82`) or the ТР-list fixes of `8602d13`** — compare SHA256 on the server with HEAD before assuming production has them. Commit `96b3a08` (docs only) needs no deploy.
- Images live in `/opt/tnved/assets` (moved there 20.09.2026); the root holds only the page, the two legal pages, `ai-risk.json`, the manifest, `server/`, `vendor/`, `backups/`. Nginx keeps `/icons/*` and `/email-logo.jpg` alive by `alias` for installed app copies and for letters already delivered.
- Database migrations `0001`–`0012` applied; daily `pg_dump` with restore check (`tnved-db-backup.timer`), pulled to the owner's machine by a scheduled task; failed units mail the admins.
- Registration requires email verification (hard gate) and Turnstile with the real key (Managed mode); the terms gate (`TERMS_VERSION` 2026-09-18) shows once to every pre-existing account.
- Contact address `info@customsassist.trade` routed by Cloudflare Email Routing and confirmed by SMTP probe (18.09.2026).
- No public release of the mobile app in either store (checked 12.09.2026); nothing is stranded by origin changes.

## Current task

No task is in progress at the last commit. The last stream of work (18–19.09.2026) was hardening the AI assistant's document reading on real and public sample document packages, and completing the position-by-position check of the ТР ЕАЭС lists.

## Recently completed

- 20.09.2026 — every site image moved into `assets/` (`assets/icons/`, `assets/source/`); page, manifest, mail template, Nginx, dev Express and both generators point there; deployed and verified live in both themes; new `static-assets.test.js`.
- 19.09.2026 — assistant: unreliable pages fall back to Vision text; EAEU goods get the indirect-tax wording; no calculation without a value; ДТ columns explained in the prompt; price in `sum_check` checked as a sum (`5ba66b0`, `5397775`).
- 19.09.2026 — the seven ТР lists published only as PDF (005, 006, 009, 011, 013, 016, 019) and 045 checked per position; 019 had four wrong forms (`8602d13`).
- 18.09.2026 (night) — direction-regime audit: bans carry direction/precision/exceptions, Единый перечень sections carry direction, check date reaches the base, `direction-regime.test.js` (`583b168`, `5a2dc82`).
- 18.09.2026 — ЕЭК unilateral-measures register reduced to Kyrgyz rows only (`9fadd1c`); CIS free-trade zone (Uzbekistan, Tajikistan, Moldova, Ukraine) added as a country property.
- 18.09.2026 — terms of use, privacy policy and `ai-risk.json` rewritten under the Цифровой кодекс КР; terms-acceptance gate (migration `0012`); `info@customsassist.trade` live.
- 18.09.2026 — UX audit second pass: verdict header, card families, sections, bottom tab bar on phones, SVG sprite icons, size tokens, contrast/tap-target/focus/dead-`@media` sweeps all at zero.
- 18.09.2026 — Document AI custom version undeployed (no more $36.50/month hosting); Google stable version is the default.

## Open issues

- Assistant answer variance: contested classifications (e.g. Würth rust remover 3402 90 900 0 vs 2710 19 980 0) differ between runs; excise on lubricants needs litres the model must ask for; gross weight vs CMR named as a discrepancy where the difference is packaging; the 94.05 / 9505.10 discrepancy on a certificate is named in one run of three; an answer's text can contradict its own calculation («Аренда склада» included in the calculation, denied in the text); the obsolete Incoterm DAT is not flagged.
- ПКМ КР № 607 от 10.09.2026 (livestock export ban, 11.09.2026–11.03.2027) is still not indexed in cbd.minjust.gov.kg; the card cites the ЕЭК register. Re-check the registry.
- No extension found for the fertilizer (№ 115, lapsed 15.09.2026) and sapling (№ 103, lapsed 01.09.2026) bans; cards say «продление в базе не найдено».
- `SOURCE_AUDIT` records still ◐: `tr` (five regulations publish no code list), `species`, `trois`, `ban`, `usir` — each states why on its card; they cannot be closed from the file side.
- The base keeps no edition history: a check date before the first known «с ДД.ММ.ГГГГ» answers «база не хранит редакций».
- Terms of use name the provider only as «Customs Assist KG», Бишкек — legal name and ИНН (ст. 115 Цифрового кодекса) to be added when the owner decides.
- Bilateral Kyrgyz agreements with Azerbaijan, Turkmenistan and Georgia have not been examined for the country filter.
- Play Console / TestFlight state is unknown from public endpoints; establish whether an upload key is registered before planning a release (`mobile/RELEASE.md`).
- `tools/build-logo.py` is stale in its page-patching half: it still looks for the data-URI logo (`<img class="auth-logo-img" src="data:image/webp…">`, gone since the page switched to `login-logo-*.webp`), so its `assert` fails after it has already rewritten the icons. Its paths were updated on 20.09.2026; the page part was not.
- `server/CHECKER.md` lists the tests without `direction-regime.test.js`; the canonical list is in `CLAUDE.md`/`docs/testing.md`.
- Production may be behind HEAD on `base.js`/`checker.js` (see «Current production state»): verify and deploy per the `deploy` skill if the hashes differ.

## Known risks

- **Two sessions in one working tree**: a whole-file write from another session discarded uncommitted edits once; a `git add` captured another session's changes once. Check `git diff --numstat` before committing; patch shared files pointwise.
- **Google Document AI stable version lifecycle**: Google discontinues a stable version when the next is released; the journal line `assistant: Document AI failed` means switch the default version (`:setDefaultProcessorVersion`, then re-read the processor). `docaiRead` fails soft.
- **Registry lag and expiring measures**: Kyrgyz acts appear in the registry one to two weeks after signing; nearest dated ends in the base are tyres antidumping 13.11.2026, pipes 21.12.2026, tariff benefits 31.12.2026, gypsum-board import ban 25.10.2026; the EAEU–UAE schedule enters force 06.10.2026.
- **Model nondeterminism**: the assistant's eval set scores 11–12 of 13 with different failures per run; compare prompt variants over several runs and read the answers, not only the checks.
- **Line endings**: any normalizing edit of the three big files produces a phantom whole-file diff or turns `\u0000` into a NUL byte.
- **Costs that accrue silently**: Vision beyond 1 000 pages/month, Document AI at 3 cents per page when readings disagree, a custom Document AI version if ever redeployed ($438/year).

## Do not break

- `base.js` never reaches a browser; `checker.js` only via `/api/checker.js`; Express serves an explicit public-file list; Nginx blocks `/server/` and `/backups/`.
- New data goes through `ENGINE_API`, never a direct reference from `checker.js`.
- `.gitattributes` `* -text`; mixed line endings in the three big files; anchored Node-script edits only; `git diff --numstat` after every edit.
- Guest-reachable code uses only names declared in the page.
- Site images live under `assets/` and are referenced as `/assets/…`; `assets/source/` is never deployed or served; the legacy `/icons/*` and `/email-logo.jpg` aliases stay in Nginx.
- Every per-user element is cleared in `resetAppView()`.
- A measure that exists only on import carries `data-dir="im"`; a partial/unverified match is never red.
- `privacy.html` names every third party and every storage location; changes ship in the same commit.
- Deploy the six application files together; migrate before restart; verify served bytes.
- `AGENTS.md` is generated from `CLAUDE.md`; «кыргызский», never «киргизский».

## Next steps

- Re-check cbd.minjust.gov.kg for ПКМ № 607 and for extensions of № 115 and № 103; update `BAN_DB` and the `ban` audit record.
- Watch the Document AI journal line after Google releases a new stable version.
- When the owner supplies the provider's requisites, add them to `terms.html` (new `TERMS_VERSION`, announced a month ahead).
- Decide on the store release path from the actual Play Console state (`mobile/RELEASE.md`).

## Last verified

- Last commit: `96b3a08` (2026-09-19 01:19 +06) — `CLAUDE.md`, `AGENTS.md`, `session.md`: прогон помощника на публичных образцах документов.
- Last deploy: 20.09.2026 03:48–03:51 UTC, backup `/root/deploy_backups/20260920_034859/` — `assets/`, `nginx.conf`, `manifest.webmanifest` and the page (page last), SHA256 verified on the server and from outside; before it, 18.09.2026 `/root/deploy_backups/20260918_191311/` (`assistant.js` of `5397775`). The `base.js`/`checker.js` commits of 18–19.09 still have no deploy record.
- Tests: on 20.09.2026 the whole list plus the new `static-assets.test.js` — 12 of 12 PASS, browser parts with Edge (`server/node_modules` had to be reinstalled: they did not survive the repo folder being renamed to `C:\CustomsAssistKG`).
- The documentation reorganisation of 20.09.2026 changed no application code; the image move of the same day changed no application logic, only paths.
- The Windows task `tnved-db-backup-pull` already points at `C:\CustomsAssistKG\server\pull-db-backups.ps1` and last ran 18.09.2026 with result 0.
