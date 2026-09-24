// «Мои коды» (services/watch.js): список, добавить, убрать. Только вошедшему пользователю с
// подтверждённым адресом. Код — 10 знаков действующего ЕТТ (пробелы и точки в запросе
// допустимы); не больше 30 кодов и 60 добавлений в сутки. Ответы — только коды и наименования
// из ЕТТ, которые и так видны в поиске; сведения о мерах база отдаёт по-прежнему через
// /api/engine с его лимитами, так что список не становится обходом лимита перебора.
const express = require('express');
const { pool } = require('../db');
const watch = require('../services/watch');

const router = express.Router();
const ADDS_PER_DAY = 60;
const adds = new Map(); // user_id → { day, n }

function guard(req, res) {
  if (!req.user) { res.status(401).json({ error: 'not authenticated', reason: req.authReason || null }); return false; }
  if (!req.user.email_verified_at) { res.status(403).json({ error: 'email_not_verified' }); return false; }
  return true;
}
const normCode = (v) => String(v == null ? '' : v).replace(/[\s.\-]/g, '').slice(0, 20);

router.get('/', async (req, res, next) => {
  if (!guard(req, res)) return;
  try {
    const { rows } = await pool.query(
      'select code, created_at, changed_at from watched_codes where user_id = $1 order by created_at', [req.user.id]);
    res.json({ max: watch.MAX_CODES, codes: rows.map((r) => ({ code: r.code, name: watch.ettName(r.code) || '', created_at: r.created_at, changed_at: r.changed_at })) });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  if (!guard(req, res)) return;
  try {
    const code = normCode((req.body || {}).code);
    if (!/^\d{10}$/.test(code)) return res.status(400).json({ error: 'code must be 10 digits' });
    if (!watch.isEttCode(code)) return res.status(404).json({ error: 'not in ETT' });
    const day = watch.todayIso();
    const a = adds.get(req.user.id);
    const n = a && a.day === day ? a.n : 0;
    if (n >= ADDS_PER_DAY) return res.status(429).json({ error: 'too many changes today' });
    const { rows: [{ count }] } = await pool.query('select count(*)::int as count from watched_codes where user_id = $1', [req.user.id]);
    const { rows: [has] } = await pool.query('select 1 as x from watched_codes where user_id = $1 and code = $2', [req.user.id, code]);
    if (has) return res.json({ ok: true, code, already: true });
    if (count >= watch.MAX_CODES) return res.status(409).json({ error: 'limit', max: watch.MAX_CODES });
    adds.set(req.user.id, { day, n: n + 1 });
    if (adds.size > 10000) adds.clear();
    const snapshot = watch.fingerprint(code, day);
    await pool.query(
      `insert into watched_codes (user_id, code, snapshot, checked_on) values ($1, $2, $3, $4::date)
       on conflict (user_id, code) do nothing`, [req.user.id, code, JSON.stringify(snapshot), day]);
    res.status(201).json({ ok: true, code, name: watch.ettName(code) || '' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:code', async (req, res, next) => {
  if (!guard(req, res)) return;
  try {
    const code = normCode(req.params.code);
    if (!/^\d{10}$/.test(code)) return res.status(400).json({ error: 'code must be 10 digits' });
    await pool.query('delete from watched_codes where user_id = $1 and code = $2', [req.user.id, code]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
