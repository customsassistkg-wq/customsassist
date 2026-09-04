const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { endUserSessions } = require('../services/sessions');

const router = express.Router();
router.use(requireAdmin);

async function audit(actorId, action, targetUserId, detail) {
  await pool.query(
    'insert into admin_audit_log (actor_id, action, target_user_id, detail) values ($1,$2,$3,$4)',
    [actorId, action, targetUserId, detail ? JSON.stringify(detail) : null]
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// users.id is a uuid (migrations/0001_init.sql), and Postgres accepts several
// textual spellings of the same value — uppercase, brace-wrapped, padded with
// whitespace. A raw path segment could therefore name the caller's own row and
// still fail a plain `=== req.user.id` comparison, slipping past the
// self-delete guard below; the same raw value handed to endUserSessions() would
// then fail to match the session JSON, which stores the canonical lowercase
// form. Normalising every :id once, here, closes both gaps — and turns an
// unparseable id into a 400 instead of letting Postgres raise 22P02 and surface
// as a generic 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeUserId(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^\{/, '').replace(/\}$/, '');
  return UUID_RE.test(s) ? s.toLowerCase() : null;
}

// Guards the "don't strand the installation without an administrator" rule
// shared by demote / disable / delete: every one of those can remove the last
// way anybody gets back into the admin panel, and there is no self-service
// recovery for that short of running scripts/create-first-admin.js on the VPS.
async function otherActiveAdminExists(excludeId) {
  const { rows } = await pool.query(
    "select 1 from users where role = 'admin' and active = true and id <> $1 limit 1",
    [excludeId]
  );
  return Boolean(rows[0]);
}

// A bare "YYYY-MM-DD" (what an <input type=date> sends) means "paid through
// the end of this day", not the start of it. Shared by user creation and
// PATCH .../subscription so both interpret the same input the same way.
// Returns { ok:true, value } or { ok:false } for an unparseable date.
function parseSubscriptionValue(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  let str = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += 'T23:59:59.999Z';
  const d = new Date(str);
  if (isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d.toISOString() };
}

router.get('/users', async (req, res, next) => {
  try {
    // "online" = seen within the last 5 minutes — slack above the 60s
    // heartbeat throttle in middleware/auth.js so a request landing just
    // before the next heartbeat isn't shown as offline.
    const { rows } = await pool.query(
      `select id, email, role, active, subscription_expires_at, created_at, last_login_at, last_seen_at,
              (last_seen_at is not null and last_seen_at > now() - interval '5 minutes') as online
       from users order by created_at asc`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const { email, password, role, subscription_expires_at } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }
    if (!EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: 'invalid email' });
    }
    if (role && role !== 'user' && role !== 'admin') {
      return res.status(400).json({ error: 'invalid role' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const sub = parseSubscriptionValue(subscription_expires_at);
    if (!sub.ok) {
      return res.status(400).json({ error: 'invalid subscription_expires_at' });
    }

    const hash = await bcrypt.hash(password, 12);
    let rows;
    try {
      ({ rows } = await pool.query(
        `insert into users (email, password_hash, role, subscription_expires_at, created_by)
         values ($1,$2,$3,$4,$5)
         returning id, email, role, active, subscription_expires_at, created_at`,
        [String(email).toLowerCase(), hash, role || 'user', role === 'admin' ? null : sub.value, req.user.id]
      ));
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'email already exists' });
      throw e;
    }

    await audit(req.user.id, 'create_user', rows[0].id, { email: rows[0].email, role: rows[0].role });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id/role', async (req, res, next) => {
  try {
    const id = normalizeUserId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid user id' });
    const { role } = req.body || {};
    if (role !== 'user' && role !== 'admin') {
      return res.status(400).json({ error: 'invalid role' });
    }

    if (role === 'user' && !(await otherActiveAdminExists(id))) {
      return res.status(400).json({ error: 'cannot demote the last administrator' });
    }

    const { rows } = await pool.query(
      'update users set role=$1 where id=$2 returning id, email, role, active',
      [role, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });

    await audit(req.user.id, 'set_role', id, { role });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id/active', async (req, res, next) => {
  try {
    const id = normalizeUserId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid user id' });
    const { active } = req.body || {};
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'invalid active' });
    }

    if (!active && !(await otherActiveAdminExists(id))) {
      return res.status(400).json({ error: 'cannot disable the last administrator' });
    }

    const { rows } = await pool.query(
      'update users set active=$1 where id=$2 returning id, email, role, active',
      [active, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });

    if (!active) {
      // Kill any live sessions for this user immediately, rather than
      // waiting for middleware/auth.js to catch it on their next request.
      await endUserSessions(id, 'disabled');
    }

    await audit(req.user.id, active ? 'enable_user' : 'disable_user', id, null);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id/subscription', async (req, res, next) => {
  try {
    const id = normalizeUserId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid user id' });
    const { subscription_expires_at } = req.body || {};
    const sub = parseSubscriptionValue(subscription_expires_at);
    if (!sub.ok) {
      return res.status(400).json({ error: 'invalid subscription_expires_at' });
    }
    const value = sub.value;

    const { rows } = await pool.query(
      'update users set subscription_expires_at=$1 where id=$2 returning id, email, role, active, subscription_expires_at',
      [value, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });

    if (value && new Date(value) <= new Date()) {
      // Setting an expiry that's already in the past is an immediate revoke
      // (e.g. correcting a mistake) — kill live sessions the same way
      // disabling an account does, rather than waiting for their next request.
      await endUserSessions(id, 'subscription_expired');
    }

    await audit(req.user.id, 'set_subscription', id, { subscription_expires_at: value });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const id = normalizeUserId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid user id' });
    if (id === req.user.id) {
      // Refuse rather than let an admin delete the very account making the
      // request — mid-request session weirdness aside, it's almost always
      // a misclick, and "disable" already covers the legitimate case.
      return res.status(400).json({ error: 'cannot delete your own account' });
    }

    const { rows: existing } = await pool.query('select id, email, role from users where id=$1', [id]);
    if (!existing[0]) return res.status(404).json({ error: 'not found' });

    if (existing[0].role === 'admin' && !(await otherActiveAdminExists(id))) {
      return res.status(400).json({ error: 'cannot delete the last administrator' });
    }

    // Log before deleting: migrations/0003 makes target_user_id go NULL on
    // delete (so the FK doesn't block this), but `detail` still snapshots
    // the email so the audit trail stays readable after the row is gone.
    await audit(req.user.id, 'delete_user', id, { email: existing[0].email });
    await endUserSessions(id, 'account_deleted');
    await pool.query('delete from users where id=$1', [id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
