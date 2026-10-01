---
name: deploy
description: Deploy tnved_checker changes to the VPS (page, base.js, checker.js, server files, migrations, nginx) in the verified order with backup, hash and syntax checks on the server, restart, outside verification and the session.md record. Use for "выложи", "задеплой", "выкладка", "обнови на сервере".
---

# Deploy

The order and the checks are in [server/CHECKER.md](../../../server/CHECKER.md) and [docs/backend-ops.md](../../../docs/backend-ops.md); this is the checklist.

1. Before anything: all relevant tests pass locally (`CLAUDE.md`, «Verification»); `git diff --numstat` matches the change; the commit exists if the owner asked for one. Know which of the six coupled files changed (`private/base.js`, `private/checker.js`, `src/services/base.js`, `src/routes/engine.js`, `src/services/assistant.js`, `src/index.js`) — they ship together. The administrators' dashboard (`dash/index.html`, `private/dash.js`, `src/routes/dash.js`, `src/services/metrics.js`) ships with `src/` and needs `DASH_ORIGIN` in `.env`; its host, DNS record and certificate expansion are in `docs/backend-ops.md`, «The administrators' dashboard».
2. On the server: back up the files being replaced to `/root/deploy_backups/<timestamp>/` (outside the web root). If a migration is included, apply it **before** the restart (`psql -f`, once, in order).
3. If `server/nginx.conf` changed: install, `nginx -t`, reload; check HSTS on `/`, the page, the manifest and an `/api/` route.
4. Images: upload `assets/` (never `assets/source/`) **before** the page that references them; `chown -R tnved:tnved /opt/tnved/assets`. Then copy each file next to its target (`*.new`), compare SHA256 with the local file, check syntax **on the server** (`node --check` for JS; `new vm.Script` on the page's first bare `<script>` for the HTML; `JSON.parse` for JSON), then `mv` into place and `chown tnved:tnved`.
5. `systemctl restart tnved` only when something under `server/` changed; confirm it listens on `127.0.0.1:3000` within seconds and the journal is clean. Put the public page in place **last**, atomically.
6. From outside: served page SHA256 equals the local file and contains the new text; `/api/checker.js` and `/api/engine` answer 401 without a session; `/server/private/base.js` answers 404; with a session `/api/checker.js` is hundreds of KB; a search by code works in a browser (a one-off administrator session for it: `server/scripts/oneoff-session.js`, [docs/backend-ops.md](../../../docs/backend-ops.md) — drop it afterwards); for assistant changes, one live question.
7. Rollback: previous page first, then the backend files from the backup; keep the source and backup blocks in Nginx.
8. Record in `session.md`: time (UTC), commit, backup directory, hashes, what was verified. Update `CURRENT.md` («Last verified», production state). Push to both remotes if the owner asked for the commit.
