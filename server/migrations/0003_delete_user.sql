-- Allows actually deleting a user row (not just disabling it). Without this,
-- DELETE FROM users fails with a foreign-key violation the moment the user
-- has any admin_audit_log entry (which happens immediately on creation) or
-- has created other users themselves (users.created_by).
--
-- ON DELETE SET NULL keeps the audit trail readable (the actor/target
-- becomes NULL, but admin_audit_log.detail already snapshots the email at
-- the time of the action) instead of losing history entirely.

alter table admin_audit_log drop constraint admin_audit_log_actor_id_fkey;
alter table admin_audit_log add constraint admin_audit_log_actor_id_fkey
  foreign key (actor_id) references users(id) on delete set null;

alter table admin_audit_log drop constraint admin_audit_log_target_user_id_fkey;
alter table admin_audit_log add constraint admin_audit_log_target_user_id_fkey
  foreign key (target_user_id) references users(id) on delete set null;

alter table users drop constraint users_created_by_fkey;
alter table users add constraint users_created_by_fkey
  foreign key (created_by) references users(id) on delete set null;
