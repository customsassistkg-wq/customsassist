# Разбор находок дозора из Telegram: рутина Claude Code (29.09.2026)

**Read before touching `server/src/routes/ops.js`, `server/ops/`, the bot's webhook, or the routine on claude.ai.**

## How it works

1. The source watch (`scripts/watch-sources.js --mail`, daily) sends the administrators a Telegram summary and saves the full report to `server/var/watch-last.txt`.
2. The owner replies to the summary with **«разобрать»** (also «добавь», «закоммить»; words after the command go to the routine as a wish, e.g. «разобрать только квоту»). Telegram delivers the message to `POST /api/ops/telegram` with the header `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`; only chats in `TELEGRAM_ADMIN_CHAT_IDS` are obeyed.
3. The server fires the routine (`ROUTINE_FIRE_URL`, `ROUTINE_TOKEN`; beta header `experimental-cc-routine-2026-04-01`) with the summary as `text` and answers with the session link. A second «разобрать» within 20 minutes, before a report, does not start a second run.
4. The routine works on a `claude/…` branch of `customsassistkg-wq/customsassist`, pushes it, and POSTs its report to `/api/ops/report` (`x-ops-secret` = `OPS_REPORT_SECRET`); the server forwards it to the administrators.
5. The owner replies **«выложи»**. The API only writes `server/var/deploy-request.json`; `tnved-deploy.path` starts `tnved-deploy.service` (root), which runs `/usr/local/lib/tnved-deploy/deploy-branch.js` (a root-owned copy of `server/ops/deploy-branch.js`): fetch the branch with the deploy key, require it to grow from the mirror's `main`, refuse any file outside the allowed set (only `server/private/base.js` and `server/scripts/watch-sources.js` are deployed; tests, `docs/*.md`, `session.md`, `CURRENT.md` may change; the page, `checker.js` and `src/` never go this way), `node --check`, the offline tests as `tnved` in a temporary copy, backup to `/root/deploy_backups/<ts>_telegram/`, replace, restart, check the base answers, roll back on failure, fast-forward `main` in the mirror and on GitHub (no force), report to Telegram.
6. **«статус»** — what is running, the last report and the last deploy.

The human gate is «выложи»: the routine never deploys, and the server deploys only a branch whose report the owner has read. Because the push to `main` on GitHub now also comes from the server, **`git pull` before working on this machine**.

## Setup (once)

**Server** (`.env`, root): `TELEGRAM_WEBHOOK_SECRET` (32+ chars `A-Za-z0-9_-`), `OPS_REPORT_SECRET`, and — after the routine exists — `ROUTINE_FIRE_URL`, `ROUTINE_TOKEN`. Directory `/opt/tnved/server/var` (tnved, 750). Deploy key `/root/.ssh/deploy_customsassist` (ed25519), its public half added on GitHub as a deploy key **with write access** (repository → Settings → Deploy keys); `github.com` in `/root/.ssh/known_hosts` checked against GitHub's published fingerprint. Units `server/ops/tnved-deploy.{path,service}` in `/etc/systemd/system/`, `systemctl enable --now tnved-deploy.path`. Webhook: `node scripts/telegram-webhook.js set` (after it `scripts/telegram-chat-id.js` needs `delete` first — getUpdates and a webhook exclude each other).

**claude.ai → Code → Routines → New routine** (the account needs a Pro, Max, Team or Enterprise plan; the Claude GitHub App installed on the repository):
- Repository: `customsassistkg-wq/customsassist`.
- Environment: its own, **Network access: Custom**, allowed domains `cbd.minjust.gov.kg`, `gov.kg`, `www.gov.kg`, `customs.gov.kg`, `www.customs.gov.kg`, `docs.eaeunion.org`, `eec.eaeunion.org`, `nsi.eaeunion.org`, `remedies.eaeunion.org`, `kenesh.kg`, `sti.gov.kg`, `vet.gov.kg`, `customsassist.trade`, plus «Also include default list of common package managers». Environment variables: `OPS_REPORT_URL=https://customsassist.trade/api/ops/report`, `OPS_REPORT_SECRET=<same as on the server>`.
- Trigger: **API**. After saving, copy the URL and the token (shown once) into the server's `.env` as `ROUTINE_FIRE_URL` and `ROUTINE_TOKEN`, restart `tnved`.
- Prompt — the text below, as is.

## The routine's prompt

```
Ты работаешь над Customs Assist KG — репозиторий customsassistkg-wq/customsassist.

1. Прочитай CLAUDE.md и CURRENT.md, затем .claude/skills/legal-source-audit/SKILL.md и документы, на которые он ссылается (docs/legal-sources.md, docs/source-audit.md, docs/base-architecture.md). Их правила обязательны.

2. В блоке routine-fire-payload — находки дозора источников (scripts/watch-sources.js), которые владелец велел разобрать, и, возможно, его пожелание. Разбери каждую находку по этим правилам:
   - только официальные источники; ничего не выдумывать — ни номеров, ни дат, ни ставок, ни ссылок;
   - в базу — только кыргызские национальные меры; законопроект — не норма, в базу не вносится;
   - истёкший срок меры — повод искать продление в реестре и на gov.kg, а не вывод;
   - запись SOURCE_AUDIT — в том же коммите, дата — только проверки, которую ты сделал;
   - server/private/base.js правится только Node-скриптом, который пишет обратно ровно прочитанные байты (смешанные концы строк — CLAUDE.md, «Editing safety»), с проверками после правки.
   Если находку разобрать нельзя (источник недоступен, текста нет) — не меняй базу, а напиши это в отчёте.

3. Менять можно только: server/private/base.js, server/scripts/watch-sources.js, server/tests/*.test.js, docs/*.md, session.md, CURRENT.md. Любой другой файл сервер не выложит и отклонит всю ветку.

4. Работай в новой ветке claude/watch-<ГГГГММДД-ччмм> от свежего main. Перед коммитом: node --check server/private/base.js; тесты node server/tests/engine.test.js, lookup-filter, direction-regime, assistant, watch-sources; node tools/base-sweep.js. Запиши в session.md, что прочитано и что изменено. Коммит — по-русски, в стиле журнала. Запушь ветку. В main не пушь и ничего не выкладывай на сервер — это делает сервер по команде владельца.

5. В конце обязательно отправь отчёт (summary — по-русски, до 1500 знаков: что нашёл, что изменил, что проверил, что осталось открытым):
   curl -sS -X POST "$OPS_REPORT_URL" -H "x-ops-secret: $OPS_REPORT_SECRET" -H "content-type: application/json" --data @report.json
   где report.json — {"status":"changed","branch":"<ветка>","commit":"<полный sha>","summary":"…"}.
   Если менять нечего — {"status":"no-change","summary":"почему"}; если не удалось — {"status":"failed","summary":"что помешало"}. report.json не коммить.
```
