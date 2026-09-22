const { pool } = require('../db');

// Soft-invalidates every session belonging to a user: strips the session's
// userId (so middleware/auth.js treats it as logged out on the very next
// request) but keeps the row and stamps a reason, so that request's
// response can tell the browser *why* it was logged out instead of just
// bouncing to a blank login screen. Used whenever a session needs to end
// from an action taken outside that browser itself — a fresh login
// elsewhere, a password reset, an admin disabling the account or setting
// an already-past subscription date.
//
// Сессия дашборда администраторов (dash.customsassist.trade) помечена в JSON полем
// dash:true — cookie принадлежит другому хосту, и это отдельный вход. Замена сессии
// при новом входе («один аккаунт — одна сессия») действует внутри своего круга:
// вход на дашборд не выбивает администратора из основного сайта и наоборот
// ({dash:true|false} в opts). Все остальные причины — отключение, удаление, истечение
// подписки, сброс пароля — завершают обе.
async function endUserSessions(userId, reason, db = pool, opts = {}) {
  const scoped = typeof opts.dash === 'boolean';
  await db.query(
    `update session
       set sess = (sess::jsonb - 'userId' || jsonb_build_object('endReason', $2::text))::json
     where sess ->> 'userId' = $1${scoped ? " and coalesce(sess ->> 'dash', 'false') = $3" : ''}`,
    scoped ? [userId, reason, String(opts.dash)] : [userId, reason]
  );
}

module.exports = { endUserSessions };
