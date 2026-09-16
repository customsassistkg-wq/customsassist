const express = require('express');
const { pool } = require('../db');
const { ask } = require('../services/assistant');

const router = express.Router();

// Каждый вопрос — несколько платных вызовов модели. Лимит на пользователя,
// а не на IP: доступ и так только после входа, а офис за одним NAT не должен
// делить один лимит на всех.
const LIMIT = Number(process.env.AI_DAILY_LIMIT || 50);
const WINDOW_MS = 24 * 60 * 60 * 1000;
const hits = new Map();
function allow(userId) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return false;
  recent.push(now);
  hits.set(userId, recent);
  return true;
}

function guard(req, res) {
  if (!req.user) { res.status(401).json({ error: 'not authenticated', reason: req.authReason || null }); return false; }
  if (!req.user.email_verified_at) { res.status(403).json({ error: 'email_not_verified' }); return false; }
  return true;
}

// Журнал не должен ронять ответ: ошибка записи только логируется.
async function logQuestion(row) {
  try {
    const { rows } = await pool.query(
      `insert into assistant_log (user_id, question, answer, searched, unverified, model, input_tokens, output_tokens, duration_ms, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [row.userId, row.question, row.answer || null, JSON.stringify(row.searched || []), JSON.stringify(row.unverified || []),
        process.env.AI_MODEL || 'deepseek-chat', row.usage?.input || 0, row.usage?.output || 0, row.ms, row.error || null]
    );
    return rows[0].id;
  } catch (err) {
    console.error('assistant log:', err.message);
    return null;
  }
}

// Ответ идёт построчным JSON (NDJSON): сначала шаги — что модель ищет, — затем
// итог. Так пользователь видит работу вместо десяти секунд немого ожидания.
// Ошибки до начала работы — обычными HTTP-статусами; после — строкой {error}.
router.post('/', async (req, res) => {
  if (!guard(req, res)) return;
  if (!process.env.AI_API_KEY) return res.status(503).json({ error: 'assistant_disabled' });

  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  // Клиент хранит переписку сам; сервер берёт только текст и только хвост.
  const history = raw.slice(-12)
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length || history[history.length - 1].role !== 'user') return res.status(400).json({ error: 'bad_request' });

  // Изображения (фото или скан инвойса) — только к последнему вопросу, только
  // JPEG/PNG/WebP, не больше четырёх и не больше ~5 МБ каждое. В журнал не пишутся.
  const rawImages = Array.isArray(req.body?.images) ? req.body.images : [];
  if (rawImages.length > 4) return res.status(400).json({ error: 'too_many_images' });
  const images = [];
  for (const img of rawImages) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(img?.media_type)
      || typeof img.data !== 'string' || img.data.length > 7_000_000 || !/^[A-Za-z0-9+/=]+$/.test(img.data)) {
      return res.status(400).json({ error: 'bad_image' });
    }
    images.push({ media_type: img.media_type, data: img.data });
  }

  if (!allow(req.user.id)) return res.status(429).json({ error: 'rate_limited', limit: LIMIT });

  res.status(200).type('application/x-ndjson');
  res.set('Cache-Control', 'no-store');
  res.set('X-Accel-Buffering', 'no');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const started = Date.now();
  const question = history[history.length - 1].content + (images.length ? ` [изображений: ${images.length}]` : '');
  try {
    const r = await ask(history, { images, onStep: (s) => send({ step: s }) });
    const id = await logQuestion({ userId: req.user.id, question, ...r, ms: Date.now() - started });
    send({ id, answer: r.answer, searched: r.searched, unverified: r.unverified });
  } catch (err) {
    console.error('assistant:', err.message);
    const error = /balance/i.test(err.message) ? 'ai_balance' : 'ai_unavailable';
    await logQuestion({ userId: req.user.id, question, error: err.message.slice(0, 500), ms: Date.now() - started });
    send({ error });
  }
  res.end();
});

// Оценка ответа: только своего и только один раз меняемым значением.
router.post('/rate', async (req, res, next) => {
  if (!guard(req, res)) return;
  const id = Number(req.body?.id);
  const rating = Number(req.body?.rating);
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 1000) : null;
  if (!Number.isInteger(id) || ![1, -1].includes(rating)) return res.status(400).json({ error: 'bad_request' });
  try {
    const { rowCount } = await pool.query(
      'update assistant_log set rating=$1, comment=coalesce($2, comment) where id=$3 and user_id=$4',
      [rating, comment || null, id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
