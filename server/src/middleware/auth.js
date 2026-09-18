const { pool } = require('../db');

// How stale last_seen_at must be before a request bothers refreshing it —
// keeps "online" in the admin panel meaningful (activity within this
// window) without turning every single authenticated request into a write.
const LAST_SEEN_THROTTLE_MS = 60 * 1000;

// Loads the current user fresh from the DB on every request (not cached in
// the session) so a role change or an admin disabling the account takes
// effect on the very next request, not just at the next login.
async function auth(req, res, next) {
  const userId = req.session.userId;
  if (!userId) {
    req.user = null;
    // A session that still exists in the store but was soft-invalidated
    // elsewhere (kicked by a fresh login, or by a password reset — see
    // services/sessions.js) carries no userId any more but does carry why.
    // Surfaced once here via req.authReason, then cleared so it isn't
    // reported again on a later request with the same cookie.
    if (req.session.endReason) {
      req.authReason = req.session.endReason;
      delete req.session.endReason;
      return req.session.save(() => next());
    }
    return next();
  }

  try {
    const { rows } = await pool.query(
      'select id, email, role, active, subscription_expires_at, last_seen_at, email_verified_at, ai_plan, terms_version from users where id = $1',
      [userId]
    );
    const user = rows[0];
    const expired = user && user.role !== 'admin'
      && user.subscription_expires_at && new Date(user.subscription_expires_at) < new Date();
    if (!user || !user.active || expired) {
      req.user = null;
      req.authReason = !user ? 'account_deleted' : !user.active ? 'disabled' : 'subscription_expired';
      return req.session.destroy(() => next());
    }
    req.user = user;
    // Fire-and-forget heartbeat: not on the response's critical path, and a
    // failure here shouldn't fail the actual request.
    if (!user.last_seen_at || Date.now() - new Date(user.last_seen_at).getTime() > LAST_SEEN_THROTTLE_MS) {
      pool.query('update users set last_seen_at=now() where id=$1', [userId]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = auth;
