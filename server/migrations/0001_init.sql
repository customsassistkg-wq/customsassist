create extension if not exists pgcrypto;

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  role          text not null default 'user' check (role in ('user','admin')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid references users(id)
);

create table admin_audit_log (
  id             bigserial primary key,
  actor_id       uuid references users(id),
  action         text not null,
  target_user_id uuid references users(id),
  detail         jsonb,
  created_at     timestamptz not null default now()
);

-- The "session" table used by connect-pg-simple is created automatically
-- at server startup (createTableIfMissing: true in src/index.js) and does
-- not need to be created here.
