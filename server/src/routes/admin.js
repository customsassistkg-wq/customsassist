const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { endUserSessions } = require('../services/sessions');
const { issueVerification } = require('../services/verification');

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
      `select id, email, role, active, subscription_expires_at, created_at, last_login_at, last_seen_at, ai_plan,
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
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }
    if (email.length > 254 || !EMAIL_RE.test(email)) {
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
    issueVerification(rows[0]).catch((err) => console.error('admin invitation failed:', err.message));
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

// Тариф AI-ассистента: base (100 вопросов в месяц, входит в подписку), pro (300), max (1000).
router.patch('/users/:id/plan', async (req, res, next) => {
  try {
    const id = normalizeUserId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid user id' });
    const { plan } = req.body || {};
    if (!['base', 'pro', 'max'].includes(plan)) return res.status(400).json({ error: 'invalid plan' });
    const { rows } = await pool.query(
      'update users set ai_plan=$1 where id=$2 returning id, email, role, active, ai_plan',
      [plan, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req.user.id, 'set_ai_plan', id, { plan });
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
    // Три года после удаления — срок из privacy.html; после delete связь с учётной записью
    // пропадёт, поэтому срок ставится сейчас, а удаляет services/retention.js.
    await pool.query("update admin_audit_log set purge_after = now() + interval '3 years' where target_user_id = $1", [id]);
    await endUserSessions(id, 'account_deleted');
    await pool.query('delete from users where id=$1', [id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Расход AI-помощника за календарный месяц по времени Бишкека (UTC+6) — основа
// счёта. Стоимость в $ берётся из журнала (посчитана в момент вопроса по ценам и
// часу пик DeepSeek), в сомах — по сегодняшнему курсу НБКР; курс в ответе, чтобы
// было видно, по какому пересчитано.
router.get('/assistant/billing', async (req, res, next) => {
  try {
    // Месяц 01–12: «2026-13» раньше проходил проверку и ронял запрос с 500.
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? req.query.month : new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const { rows } = await pool.query(
      `select u.email, u.ai_plan, count(*) filter (where l.kind = 'question')::int as questions,
              count(*) filter (where l.kind = 'read' and l.error is null)::int as pages,
              count(*) filter (where l.error is not null)::int as errors,
              sum(l.input_tokens)::int as input_tokens, sum(l.cache_read_tokens)::int as cache_read_tokens,
              sum(l.output_tokens)::int as output_tokens, round(sum(l.cost_usd), 6)::float as cost_usd
         from assistant_log l join users u on u.id = l.user_id
        where l.created_at >= $1::timestamptz and l.created_at < $2::timestamptz
        group by u.email, u.ai_plan order by cost_usd desc`,
      [`${month}-01T00:00:00+06:00`, `${next}-01T00:00:00+06:00`]
    );
    const rates = await require('../services/nbkrRates').getRates().catch(() => null);
    res.json({ month, usdRate: rates?.usd || null, rateDate: rates?.date || null, rows });
  } catch (err) {
    next(err);
  }
});

// Журнал AI-помощника: расход по пользователям за 30 дней и последние вопросы.
// ?rating=-1 — только ответы с 👎: из них собирается контрольный набор.
router.get('/assistant', async (req, res, next) => {
  try {
    const onlyBad = req.query.rating === '-1';
    const [totals, recent] = await Promise.all([
      pool.query(
        `select u.email, count(*) filter (where l.kind = 'question')::int as questions,
                count(*) filter (where l.kind = 'read' and l.error is null)::int as pages, sum(l.input_tokens)::int as input_tokens,
                sum(l.output_tokens)::int as output_tokens,
                count(*) filter (where l.rating = 1)::int as good, count(*) filter (where l.rating = -1)::int as bad,
                count(*) filter (where l.error is not null)::int as errors, max(l.created_at) as last_at, round(sum(l.cost_usd), 4)::float as cost_usd
           from assistant_log l join users u on u.id = l.user_id
          where l.created_at > now() - interval '30 days'
          group by u.email order by questions desc`
      ),
      pool.query(
        `select l.id, u.email, l.created_at, l.question, l.answer, l.searched, l.unverified, l.rating, l.comment,
                l.error, l.input_tokens, l.output_tokens, l.duration_ms
           from assistant_log l join users u on u.id = l.user_id
          where l.kind = 'question'${onlyBad ? ' and l.rating = -1' : ''}
          order by l.created_at desc limit 100`
      ),
    ]);
    res.json({ totals: totals.rows, recent: recent.rows });
  } catch (err) {
    next(err);
  }
});

// ── Деньги: оплаты подписки и постоянные расходы (миграция 0013) ────────────────────
// Оплата проходит вне сервиса (перевод, платёжное приложение, наличные); администратор
// записывает её здесь, и запись сразу продлевает подписку на оплаченные месяцы и ставит
// тариф помощника. Сумма и способ — для учёта и раздела «Экономика» дашборда.
const PLAN_KEYS = ['base', 'pro', 'max'];
const METHOD_MAX = 40, NOTE_MAX = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// До какой даты продлевает оплата на months месяцев: от текущего срока, если он ещё не
// истёк, иначе от сегодня; конец дня по UTC ставится как в parseSubscriptionValue.
// 31.01 + 1 месяц в JS перескакивает на 03.03 — держим последний день целевого месяца.
function extendedUntil(current, months, now = new Date()) {
  const from = current && new Date(current) > now ? new Date(current) : now;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, from.getUTCDate()));
  if (d.getUTCDate() !== from.getUTCDate()) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

router.get('/payments', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const { rows } = await pool.query(
      `select p.id, p.user_id, p.email, p.amount::float as amount, p.currency, p.plan, p.months, p.paid_until::text as paid_until,
              p.method, p.note, p.created_at, a.email as actor
         from payments p left join users a on a.id = p.created_by
        order by p.created_at desc limit $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/payments', async (req, res, next) => {
  try {
    const b = req.body || {};
    const id = normalizeUserId(b.user_id);
    if (!id) return res.status(400).json({ error: 'invalid user id' });
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) return res.status(400).json({ error: 'invalid amount' });
    const currency = b.currency == null || b.currency === '' ? 'KGS' : String(b.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'invalid currency' });
    const months = b.months == null ? 1 : Number(b.months);
    if (!Number.isInteger(months) || months < 1 || months > 24) return res.status(400).json({ error: 'invalid months' });
    const plan = b.plan == null || b.plan === '' ? null : String(b.plan);
    if (plan && !PLAN_KEYS.includes(plan)) return res.status(400).json({ error: 'invalid plan' });
    const method = b.method == null ? null : String(b.method).slice(0, METHOD_MAX);
    const note = b.note == null ? null : String(b.note).slice(0, NOTE_MAX);
    const extend = b.extend !== false;

    const { rows: found } = await pool.query('select id, email, role, subscription_expires_at from users where id = $1', [id]);
    const u = found[0];
    if (!u) return res.status(404).json({ error: 'not found' });
    // Администратору срок не ставится: у него доступ и так без ограничения.
    const paidUntil = extend && u.role !== 'admin' ? extendedUntil(u.subscription_expires_at, months) : null;
    const { rows } = await pool.query(
      `insert into payments (user_id, email, amount, currency, plan, months, paid_until, method, note, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id, created_at`,
      [id, u.email, amount, currency, plan, months, paidUntil, method, note, req.user.id]
    );
    let user = null;
    if (paidUntil) {
      ({ rows: [user] } = await pool.query(
        'update users set subscription_expires_at = $2, ai_plan = coalesce($3, ai_plan) where id = $1 returning id, email, subscription_expires_at, ai_plan',
        [id, paidUntil + 'T23:59:59.999Z', plan]
      ));
    } else if (plan) {
      ({ rows: [user] } = await pool.query('update users set ai_plan = $2 where id = $1 returning id, email, subscription_expires_at, ai_plan', [id, plan]));
    }
    await audit(req.user.id, 'payment', id, { amount, currency, plan, months, paid_until: paidUntil, method });
    res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at, paid_until: paidUntil, user });
  } catch (err) {
    next(err);
  }
});

// Запись убирается, подписка остаётся: срок правит администратор кнопкой «Подписка».
router.delete('/payments/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('delete from payments where id = $1 returning user_id, email, amount, currency', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req.user.id, 'delete_payment', rows[0].user_id, { email: rows[0].email, amount: Number(rows[0].amount), currency: rows[0].currency });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/expenses', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select id, name, amount::float as amount, currency, period, starts_on::text as starts_on, ends_on::text as ends_on, note, created_at
         from expenses order by ends_on nulls first, starts_on desc, id`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/expenses', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name == null ? '' : b.name).trim().slice(0, 120);
    const amount = Number(b.amount);
    const currency = b.currency == null || b.currency === '' ? 'USD' : String(b.currency).toUpperCase();
    const period = b.period == null || b.period === '' ? 'month' : String(b.period);
    const starts = b.starts_on ? String(b.starts_on) : new Date().toISOString().slice(0, 10);
    const ends = b.ends_on ? String(b.ends_on) : null;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e7) return res.status(400).json({ error: 'invalid amount' });
    if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'invalid currency' });
    if (!['month', 'year', 'once'].includes(period)) return res.status(400).json({ error: 'invalid period' });
    if (!DATE_RE.test(starts) || (ends && !DATE_RE.test(ends))) return res.status(400).json({ error: 'invalid date' });
    const note = b.note == null ? null : String(b.note).slice(0, NOTE_MAX);
    const { rows } = await pool.query(
      'insert into expenses (name, amount, currency, period, starts_on, ends_on, note) values ($1,$2,$3,$4,$5,$6,$7) returning id, created_at',
      [name, amount, currency, period, starts, ends, note]
    );
    await audit(req.user.id, 'expense_add', null, { name, amount, currency, period });
    res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (err) {
    next(err);
  }
});

router.delete('/expenses/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('delete from expenses where id = $1 returning name', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req.user.id, 'expense_delete', null, { name: rows[0].name });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.extendedUntil = extendedUntil;
