-- Второй фактор входа для администраторов (01.10.2026): одноразовые коды TOTP из приложения-аутентификатора.
--
-- Включается самим администратором в меню аккаунта (routes/auth.js, /api/auth/totp/*), по желанию. После
-- включения вход (и на сайте, и на дашборде) требует, кроме пароля, код из приложения или код восстановления.
--   totp_secret     — секрет кодов: 'v1:' + base64(iv | tag | шифротекст), AES-256-GCM, ключ из SESSION_SECRET
--                     (services/totp.js) — копия базы без .env сервера второй фактор не выдаёт;
--   totp_enabled_at — с этой даты вход требует код;
--   totp_last_step  — номер 30-секундного шага последнего принятого кода: тот же код второй раз не принимается;
--   totp_recovery   — SHA-256 неиспользованных кодов восстановления (восемь, показываются один раз).
-- Выключить без телефона и кодов — scripts/totp-off.js на сервере. Названо в privacy.html.
-- Выкладывать до перезапуска API: middleware/auth.js и routes/auth.js читают эти колонки.

alter table users add column if not exists totp_secret text;
alter table users add column if not exists totp_enabled_at timestamptz;
alter table users add column if not exists totp_last_step bigint;
alter table users add column if not exists totp_recovery jsonb;
