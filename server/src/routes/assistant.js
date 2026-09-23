const express = require('express');
const { pool } = require('../db');
const { ask, readPage, redactPersonal } = require('../services/assistant');
const { sendEmail, renderEmail, BRAND } = require('../services/email');

const router = express.Router();

// Тарифы AI-ассистента (сетка владельца, 22.09.2026): цена в сомах за месяц, вопросов в день и в
// месяц, страниц документов в месяц. Дневной лимит — против дележа одной учётной записи на офис,
// продаётся месячная квота; страницы ограничены только месяцем — всплеск держит общий суточный
// потолок расхода (AI_DAILY_BUDGET_USD). День и месяц — календарные по времени Бишкека (UTC+6).
// Вопрос с ошибкой модели не списывается: пользователь ответа не получил. Администраторы без лимита.
// Переопределение: AI_PLAN_LIMITS={"base":{"day":3,"month":90,"pages":30,"price":490},...}.
const PLANS = {
  base: { name: 'Базовый', price: 490, day: 3, month: 90, pages: 30 },
  pro: { name: 'Pro', price: 990, day: 20, month: 300, pages: 150 },
  max: { name: 'Max', price: 1990, day: 100, month: 1500, pages: 500 },
};
if (process.env.AI_PLAN_LIMITS) {
  for (const [k, v] of Object.entries(JSON.parse(process.env.AI_PLAN_LIMITS))) {
    if (!PLANS[k]) continue;
    if (typeof v === 'number') PLANS[k].month = v;
    else for (const f of ['day', 'month', 'pages', 'price']) if (v[f] != null) PLANS[k][f] = Number(v[f]);
  }
}

// Страницы документов (сканы и фото) читаются моделью по одной при прикреплении и тоже стоят денег: три чтения
// со сверкой — около 0,6 цента страница по журналу за сентябрь 2026, плюс 3 цента Document AI при споре
// прочтений. Текст PDF, таблицы и Word моделью не читаются и не считаются.

// Суточный потолок расхода на модель и распознавание по всем пользователям, $ за сутки Бишкека.
// Тарифы ограничивают одного пользователя, а не сумму: пробные учётные записи и сбойные вопросы
// (с квоты не списываются, но денег стоят) общего предела не имели. Выше потолка помощник отвечает
// 503 всем, кроме администраторов, до полуночи; администраторам уходит одно письмо. 0 — без потолка.
const DAILY_BUDGET_USD = Number(process.env.AI_DAILY_BUDGET_USD ?? 10);
let budgetAlertDay = null;
function budgetAlert(spent) {
  const day = ymd(new Date());
  if (budgetAlertDay === day) return;
  budgetAlertDay = day;
  console.error(`assistant: daily budget reached: $${spent.toFixed(2)} of $${DAILY_BUDGET_USD}`);
  if (!process.env.RESEND_API_KEY) return;
  (async () => {
    const { rows } = await pool.query("select email from users where role = 'admin' and active = true order by created_at");
    const html = renderEmail({
      title: 'AI-ассистент остановлен до конца суток',
      intro: `Расход на модель и распознавание за сегодня (по Бишкеку) — $${spent.toFixed(2)} при суточном потолке $${DAILY_BUDGET_USD}.`
        + ' Пользователи получают отказ до полуночи; администраторы работают без ограничения.',
      outro: 'Кто потратил — в админ-панели, «AI-ассистент». Потолок меняется переменной AI_DAILY_BUDGET_USD в .env (0 — без потолка).',
      footNote: 'Письмо отправлено автоматически: /api/assistant.',
    });
    for (const r of rows) await sendEmail({ to: r.email, subject: `Суточный потолок расхода AI — ${BRAND}`, html });
  })().catch((err) => console.error('assistant budget alert failed:', err.message));
}

const TZ = 6 * 3600e3;
function bishkekMonth(now = new Date()) {
  const b = new Date(now.getTime() + TZ);
  const y = b.getUTCFullYear(), m = b.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1) - TZ), next: new Date(Date.UTC(y, m + 1, 1) - TZ) };
}
function bishkekDay(now = new Date()) {
  const b = new Date(now.getTime() + TZ);
  const start = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - TZ);
  return { start, next: new Date(start.getTime() + 24 * 3600e3) };
}
const ymd = (d) => new Date(d.getTime() + TZ).toISOString().slice(0, 10);

async function quotaFor(user) {
  const month = bishkekMonth(), day = bishkekDay();
  const { rows } = await pool.query(
    `select count(*) filter (where kind = 'question')::int as used,
            count(*) filter (where kind = 'question' and created_at >= $3)::int as used_today,
            count(*) filter (where kind = 'read')::int as pages,
            count(*) filter (where kind = 'read' and created_at >= $3)::int as pages_today,
            (select coalesce(sum(cost_usd), 0) from assistant_log where created_at >= $3)::float as spent_all
       from assistant_log where user_id = $1 and created_at >= $2 and error is null`,
    [user.id, month.start, day.start]
  );
  const used = rows[0]?.used || 0, usedToday = rows[0]?.used_today || 0;
  const pages = rows[0]?.pages || 0, pagesToday = rows[0]?.pages_today || 0;
  const plans = Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, { name: v.name, price: v.price, day: v.day, month: v.month, pages: v.pages }]));
  const base = { used, usedToday, pages, pagesToday, resets: ymd(month.next), tomorrow: ymd(day.next), plans };
  // Сама сумма пользователю не уходит — только признак.
  const spentAll = rows[0]?.spent_all || 0;
  if (DAILY_BUDGET_USD > 0 && spentAll >= DAILY_BUDGET_USD) {
    budgetAlert(spentAll);
    if (user.role !== 'admin') base.overBudget = true;
  }
  if (user.role === 'admin') return { plan: 'admin', name: 'Администратор', limit: null, day: null, remaining: null, pagesRemaining: null, ...base };
  const plan = PLANS[user.ai_plan] ? user.ai_plan : 'base';
  const p = PLANS[plan];
  const leftMonth = Math.max(0, p.month - used), leftDay = Math.max(0, p.day - usedToday);
  // Страницы — только месячный лимит; поле pagesDay остаётся для интерфейса и равно месячному.
  const pagesDay = p.pages, pagesMonth = p.pages;
  return {
    plan, name: p.name, price: p.price, limit: p.month, day: p.day, ...base,
    remainingMonth: leftMonth, remainingDay: leftDay,
    remaining: Math.min(leftMonth, leftDay),
    pagesDay, pagesMonth,
    pagesRemaining: Math.max(0, Math.min(pagesMonth - pages, pagesDay - pagesToday)),
    pagesBlockedBy: pagesMonth - pages <= pagesDay - pagesToday ? 'month' : 'day',
    // Что держит: исчерпан месяц — ждать завтра бесполезно, поэтому месяц главнее.
    blockedBy: leftMonth === 0 ? 'month' : (leftDay <= leftMonth ? 'day' : 'month'),
  };
}

const inFlight = new Set();
const readsInFlight = new Map();
const base64 = (v) => typeof v === 'string' && v.length <= 7_000_000 && /^[A-Za-z0-9+/=]+$/.test(v);

function guard(req, res) {
  if (!req.user) { res.status(401).json({ error: 'not authenticated', reason: req.authReason || null }); return false; }
  if (!req.user.email_verified_at) { res.status(403).json({ error: 'email_not_verified' }); return false; }
  return true;
}

// Журнал не должен ронять ответ: ошибка записи только логируется.
async function logQuestion(row) {
  try {
    const { rows } = await pool.query(
      `insert into assistant_log (user_id, question, answer, searched, unverified, model, input_tokens, output_tokens, duration_ms, error, cache_read_tokens, cost_usd, kind)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [row.userId, row.question, row.answer || null, JSON.stringify(row.searched || []), JSON.stringify(row.unverified || []),
        process.env.AI_MODEL || 'deepseek-flash', row.usage?.input || 0, row.usage?.output || 0, row.ms, row.error || null,
        row.usage?.cacheRead || 0, row.usage?.costUsd || 0, row.kind || 'question']
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
  // JPEG/PNG/WebP, не больше восьми и не больше ~5 МБ каждое. alt — та же страница,
  // повёрнутая на 180°: по ней читается страница, отсканированная вверх ногами. В журнал не пишутся.
  const rawImages = Array.isArray(req.body?.images) ? req.body.images : [];
  if (rawImages.length > 8) return res.status(400).json({ error: 'too_many_images' });
  const images = [];
  for (const img of rawImages) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(img?.media_type) || !base64(img.data) || (img.alt !== undefined && !base64(img.alt))) {
      return res.status(400).json({ error: 'bad_image' });
    }
    images.push({ media_type: img.media_type, data: img.data, ...(img.alt ? { alt: img.alt } : {}) });
  }

  // Документы диалога: текст PDF, расшифровки страниц (/read), таблицы Excel и CSV, Word. Браузер присылает
  // их с каждым вопросом — до 30 файлов и 300 тыс. знаков на диалог (около 100 тыс. токенов при контексте
  // модели в 1 млн). Текст документов в журнал не пишется — только имена файлов.
  const rawDocs = Array.isArray(req.body?.docs) ? req.body.docs : [];
  if (rawDocs.length > 30) return res.status(400).json({ error: 'too_many_docs' });
  const docs = [];
  let docChars = 0;
  for (const d of rawDocs) {
    if (typeof d?.name !== 'string' || typeof d.text !== 'string' || !d.text.trim()) return res.status(400).json({ error: 'bad_doc' });
    docChars += d.text.length;
    if (docChars > 300000) return res.status(400).json({ error: 'doc_too_long' });
    docs.push({ name: d.name.slice(0, 200), pages: Number.isInteger(d.pages) && d.pages > 0 ? d.pages : null, text: d.text, cut: d.cut === true });
  }

  // Один вопрос в работе на пользователя. Лимит считается по журналу, а запись
  // появляется только после ответа модели, то есть через десятки секунд: без этого
  // все параллельные запросы видели нетронутый лимит (10 из 10 при лимите 3 в день).
  // has и add — до первого await, иначе два запроса проскочат между ними.
  // ponytail: множество в памяти одного процесса; при нескольких экземплярах API — блокировка в БД.
  if (inFlight.has(req.user.id)) return res.status(429).json({ error: 'busy' });
  inFlight.add(req.user.id);
  try {
    let quota;
    try { quota = await quotaFor(req.user); } catch (err) { console.error('assistant quota:', err.message); return res.status(500).json({ error: 'internal error' }); }
    if (quota.overBudget) return res.status(503).json({ error: 'assistant_budget' });
    if (quota.remaining === 0) return res.status(429).json({ error: 'quota_exceeded', quota });

    res.status(200).type('application/x-ndjson');
    res.set('Cache-Control', 'no-store');
    res.set('X-Accel-Buffering', 'no');
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');
    const started = Date.now();
    const question = history[history.length - 1].content + (images.length ? ` [изображений: ${images.length}]` : '')
      + (docs.length ? ` [документы: ${docs.map((d) => d.name).join(', ')}]` : '');
    try {
      const r = await ask(history, { images, docs, onStep: (s) => send({ step: s }) });
      const id = await logQuestion({ userId: req.user.id, question, ...r, ms: Date.now() - started });
      send({ id, answer: r.answer, searched: r.searched, unverified: r.unverified, quota: await quotaFor(req.user).catch(() => null) });
    } catch (err) {
      console.error('assistant:', err.message);
      const error = /balance/i.test(err.message) ? 'ai_balance' : 'ai_unavailable';
      await logQuestion({ userId: req.user.id, question, error: err.message.slice(0, 500), usage: err.usage, ms: Date.now() - started });
      send({ error });
    }
    res.end();
  } finally {
    inFlight.delete(req.user.id);
  }
});

// Страница документа (скан или фото), прикреплённого к чату. Браузер присылает страницы по одной сразу при
// прикреплении и получает расшифровку, а вопрос потом несёт только текст: документ может быть длинным без
// 15-мегабайтного запроса и минутного ожидания ответа, и уточняющие вопросы видят его. Перевёрнутая страница —
// ответ {rotate: 180}: браузер поворачивает её и присылает снова с checked: true. Каждая страница — запись
// журнала (kind = 'read') со своей стоимостью; лимит — pagesRemaining. До четырёх страниц пользователя разом.
router.post('/read', async (req, res) => {
  if (!guard(req, res)) return;
  if (!process.env.AI_API_KEY) return res.status(503).json({ error: 'assistant_disabled' });
  const img = req.body?.image;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(img?.media_type) || !base64(img.data)) return res.status(400).json({ error: 'bad_image' });
  // parts — та же страница двумя-тремя полосами покрупнее (services/assistant.js, readPage)
  const parts = Array.isArray(req.body?.parts) ? req.body.parts : [];
  if (parts.length > 3 || parts.some((p) => !['image/jpeg', 'image/png', 'image/webp'].includes(p?.media_type) || !base64(p.data))) return res.status(400).json({ error: 'bad_image' });
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 200) : 'изображение';
  const uid = req.user.id;
  if ((readsInFlight.get(uid) || 0) >= 4) return res.status(429).json({ error: 'busy' });
  readsInFlight.set(uid, (readsInFlight.get(uid) || 0) + 1);
  try {
    let quota;
    try { quota = await quotaFor(req.user); } catch (err) { console.error('assistant quota:', err.message); return res.status(500).json({ error: 'internal error' }); }
    if (quota.overBudget) return res.status(503).json({ error: 'assistant_budget' });
    if (quota.pagesRemaining === 0) return res.status(429).json({ error: 'page_quota_exceeded', quota });
    const started = Date.now();
    const question = `[страница документа: ${name}]`;
    try {
      const r = await readPage({ media_type: img.media_type, data: img.data },
        { checkOrientation: req.body.checked !== true, parts: parts.map((p) => ({ media_type: p.media_type, data: p.data })) });
      await logQuestion({ userId: uid, question: question + (r.rotate ? ' — перевёрнута' : ''), usage: r.usage, ms: Date.now() - started, kind: 'read' });
      res.set('Cache-Control', 'no-store');
      // Расшифровка возвращается уже очищенной от персональных данных: браузер держит ровно тот
      // текст, который уйдёт в модель, и показывает его пользователю перед отправкой.
      res.json(r.rotate ? { rotate: r.rotate } : { text: redactPersonal(r.text) });
    } catch (err) {
      console.error('assistant read:', err.message);
      await logQuestion({ userId: uid, question, error: err.message.slice(0, 500), usage: err.usage, ms: Date.now() - started, kind: 'read' });
      res.status(502).json({ error: /balance/i.test(err.message) ? 'ai_balance' : 'read_failed' });
    }
  } finally {
    const n = (readsInFlight.get(uid) || 1) - 1;
    if (n) readsInFlight.set(uid, n); else readsInFlight.delete(uid);
  }
});

// Очистка текста, извлечённого браузером из PDF, таблицы или Word: браузер показывает
// пользователю ровно то, что уйдёт в модель, и даёт убрать лишнее руками. Правила — одни и те же
// (services/assistant.js), и ask() чистит присланное ещё раз: правка в браузере может только
// убрать данные, но не вернуть их.
router.post('/clean', (req, res) => {
  if (!guard(req, res)) return;
  const text = req.body?.text;
  if (typeof text !== 'string' || text.length > 400000) return res.status(400).json({ error: 'bad_text' });
  res.set('Cache-Control', 'no-store');
  res.json({ text: redactPersonal(text) });
});

// Остаток вопросов по тарифу — для строки под полем ввода.
router.get('/quota', async (req, res, next) => {
  if (!guard(req, res)) return;
  try { res.json(await quotaFor(req.user)); } catch (err) { next(err); }
});

// Оценка ответа: только своего; передумать можно — новая оценка заменяет прежнюю.
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
module.exports.bishkekMonth = bishkekMonth;
module.exports.bishkekDay = bishkekDay;
module.exports.PLANS = PLANS;
// Для дашборда администраторов (routes/dash.js): потолок расхода и число вопросов в работе.
module.exports.DAILY_BUDGET_USD = DAILY_BUDGET_USD;
module.exports.inFlight = inFlight;
