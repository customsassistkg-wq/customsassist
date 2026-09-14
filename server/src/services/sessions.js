const { pool } = require('../db');

// Soft-invalidates every session belonging to a user: strips the session's
// userId (so middleware/auth.js treats it as logged out on the very next
// request) but keeps the row and stamps a reason, so that request's
// response can tell the browser *why* it was logged out instead of just
// bouncing to a blank login screen. Used whenever a session needs to end
// from an action taken outside that browser itself — a fresh login
// elsewhere, a password reset, an admin disabling the account or setting
// an already-past subscription date.
async function endUserSessions(userId, reason, db = pool) {
  await db.query(
    `update session
       set sess = (sess::jsonb - 'userId' || jsonb_build_object('endReason', $2::text))::json
     where sess ->> 'userId' = $1`,
    [userId, reason]
  );
}

module.exports = { endUserSessions };
