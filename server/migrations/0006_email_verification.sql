-- Подтверждение адреса почты при саморегистрации.
--
-- До этой миграции регистрация не проверяла адрес вообще: аккаунт создавался
-- сразу и сразу логинился, поэтому в базе появились записи с опечаткой в
-- домене (например esenbek@exampl.com) — такому пользователю не дойдёт ни
-- письмо о сбросе пароля, ни что-либо ещё.
--
-- Токен, как и у сброса пароля, хранится только своим sha256-хешем: утечка
-- базы сама по себе не даёт рабочих ссылок подтверждения.

alter table users add column if not exists email_verified_at timestamptz;

create table if not exists email_verification_tokens (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_verification_tokens_user_id_idx
  on email_verification_tokens(user_id);

-- Учётные записи, заведённые администратором вручную, считаются
-- подтверждёнными: их адрес вводил человек, который знает получателя, и
-- требовать от них подтверждения задним числом значило бы отрезать доступ
-- тем, кто уже работает.
update users
   set email_verified_at = created_at
 where email_verified_at is null
   and (role = 'admin' or created_by is not null);
