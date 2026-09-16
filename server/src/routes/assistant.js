const express = require('express');
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

router.post('/', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated', reason: req.authReason || null });
  if (!req.user.email_verified_at) return res.status(403).json({ error: 'email_not_verified' });
  if (!process.env.AI_API_KEY) return res.status(503).json({ error: 'assistant_disabled' });

  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  // Клиент хранит переписку сам; сервер берёт только текст и только хвост.
  const history = raw.slice(-12)
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length || history[history.length - 1].role !== 'user') return res.status(400).json({ error: 'bad_request' });

  if (!allow(req.user.id)) return res.status(429).json({ error: 'rate_limited', limit: LIMIT });

  try {
    res.json(await ask(history));
  } catch (err) {
    console.error('assistant:', err.message);
    const insufficient = /balance/i.test(err.message);
    res.status(502).json({ error: insufficient ? 'ai_balance' : 'ai_unavailable' });
  }
});

module.exports = router;
