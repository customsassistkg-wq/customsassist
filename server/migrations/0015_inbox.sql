-- Обращения: входящая почта info@ и ответы на неё (23.09.2026).
--
-- Письмо приходит на Cloudflare Email Routing, попадает в Email Worker
-- (server/cloudflare/inbound-email.js), и тот передаёт его целиком на POST /api/mail/inbound.
-- Разбирает письмо сервер (services/mailparse.js): в базу идут адрес, тема, текст и список
-- вложений. Сознательно НЕ хранится: сырое письмо, HTML-часть и содержимое вложений. HTML
-- превращается в текст при разборе, поэтому чужая разметка не попадает в админ-панель, а
-- вложения остаются в копии письма, которую Worker пересылает владельцу на почту.
--
-- Строки об исходящих ответах лежат в этой же таблице (direction = 'out'): переписка
-- читается одной лентой, а thread_key связывает письма одной цепочки.
--
-- Срок хранения — год с момента письма (purge_after), чистит services/retention.js, как
-- журнал администрирования и оплаты. Названо в privacy.html.
--
-- Выкладывать до перезапуска API: routes/mail.js и routes/admin.js читают эту таблицу.

create table if not exists inbox (
  id           bigserial primary key,
  direction    text not null default 'in' check (direction in ('in', 'out')),
  message_id   text,
  in_reply_to  text,
  thread_key   text,
  from_email   text not null,
  from_name    text,
  to_email     text,
  subject      text,
  body_text    text,
  had_html     boolean not null default false,
  size_bytes   integer not null default 0,
  attachments  jsonb not null default '[]',
  auth_results text,
  -- Учётная запись с тем же адресом, если она есть: в админке сразу видно тариф и подписку.
  -- Письмо переживает удаление учётной записи: переписка нужна и после неё.
  user_id      uuid references users(id) on delete set null,
  status       text not null default 'new' check (status in ('new', 'open', 'done', 'spam')),
  read_at      timestamptz,
  answered_at  timestamptz,
  created_at   timestamptz not null default now(),
  purge_after  timestamptz not null default now() + interval '1 year'
);

create index if not exists inbox_created_idx on inbox (created_at desc);
create index if not exists inbox_thread_idx on inbox (thread_key, created_at);
create index if not exists inbox_open_idx on inbox (status) where status in ('new', 'open');
create index if not exists inbox_purge_idx on inbox (purge_after);
