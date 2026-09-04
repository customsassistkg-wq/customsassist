alter table users
  add column last_login_at timestamptz,
  add column last_seen_at  timestamptz;
