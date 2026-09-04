-- Paid-access window per user. NULL means no expiry restriction (used for
-- admin/staff accounts and for users an admin hasn't billed yet) — access is
-- gated by `active` alone in that case. A non-null value in the past means
-- the account is locked out at login and on every subsequent request, the
-- same way `active = false` already works (see middleware/auth.js).
alter table users add column subscription_expires_at timestamptz;
