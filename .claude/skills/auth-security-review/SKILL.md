---
name: auth-security-review
description: Project-specific security review of tnved_checker — auth, sessions, CSRF/Origin, registration and verification, Turnstile, admin authorization, the /api/engine boundary and enumeration limits, private files (base.js, checker.js), data exposure between users, headers, secrets, privacy-policy consistency. Use for "проверь безопасность", "может ли кто-то скачать базу", "ревью авторизации".
---

# Auth and security review

1. Read [docs/security-auth.md](../../../docs/security-auth.md) and [server/CHECKER.md](../../../server/CHECKER.md); for server configuration, headers and backups, [docs/backend-ops.md](../../../docs/backend-ops.md). Do not re-litigate decisions recorded there (registration answers 409 on purpose; login spends bcrypt on every path; hard email gate; grandfathered accounts).
2. Walk the boundaries in code, not from memory: `server/src/index.js` (middleware order: Origin check → session → body limits → routes; explicit public-file list), `middleware/auth.js` (column list of the user SELECT), `routes/checker.js` and `routes/engine.js` (verified email, `no-store`, `ENGINE_LIMITS`, whitelist of `ENGINE_API`), `routes/admin.js` (`router.use(requireAdmin)`), `routes/auth.js` (register/login/forgot/reset/verify/accept-terms, `publicOrigin()`), `services/turnstile.js` (fail closed, hostname and action), `server/nginx.conf` (blocked paths, HSTS on every location with its own `add_header`, rate limit, body sizes).
3. Check the client side too: everything reachable by a guest uses only names declared in the page; `resetAppView()` clears every per-user element; `setSearchMode('admin')` refuses non-admins; attachments of a previous user are dropped when the assistant page is rebuilt.
4. Probe from outside where possible: 401 without a session on `/api/checker.js` and `/api/engine`; 404 on `/server/private/base.js`; 403 without `Origin`; the size of `/api/checker.js` with a session (hundreds of KB, never 12 MB); a non-admin session on `/api/admin/users` gets 403.
5. Verify that nothing new stores or transfers user data without `privacy.html` saying so, and that no secret is in the repo, the page or a doc.
6. Run `api-boundary`, `login-enumeration`, `engine`, `checker-access`, `auth-loader`, `admin-view`, `admin-invitation`, and `reset-password` with `TEST_DATABASE_URL`.
7. Report findings by severity with file and line; fix only when asked, one root cause at a time; record decisions in `session.md` and any new rule in `docs/security-auth.md`.
