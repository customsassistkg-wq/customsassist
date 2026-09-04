-- Password-reset tokens. The token itself is never stored — only a sha256
-- hash of it — so a DB leak alone doesn't hand out working reset links
-- (same idea as password_hash for the login password itself).
create table password_reset_tokens (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index password_reset_tokens_user_id_idx on password_reset_tokens(user_id);
