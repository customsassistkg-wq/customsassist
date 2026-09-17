// Запросы браузера к базе: POST /api/engine {fn, args} → {result}.
//
// С 17.09.2026 база не уходит в браузер (private/base.js только на сервере), и этот
// маршрут — единственный путь к ней для вошедшего пользователя. Отдаёт он ответ на
// один запрос, поэтому скопировать базу можно только перебором, и перебор здесь
// ограничен: по числу запросов и, главное, по числу разных товарных позиций за сутки.
const express = require('express');
const { pool } = require('../db');
const base = require('../services/base');
const { sendEmail, renderEmail, BRAND } = require('../services/email');

const router = express.Router();

// Поиск идёт по мере набора кода, поэтому человек за работой делает десятки запросов в
// минуту, но за день открывает десятки, от силы сотни товарных позиций, а не 1 200
// позиций ЕТТ и не все сочетания букв для поиска по названию. keysAlert — письмо
// администраторам, keysLimit и perDay — отказ до конца суток по Бишкеку.
// Переопределение: ENGINE_LIMITS={"perMinute":120,"perDay":5000,"keysAlert":300,"keysLimit":800}.
const LIMITS = { perMinute: 120, perDay: 5000, keysAlert: 300, keysLimit: 800,
  ...(process.env.ENGINE_LIMITS ? JSON.parse(process.env.ENGINE_LIMITS) : {}) };

// ponytail: счётчики в памяти одного процесса и обнуляются при перезапуске; при
// нескольких экземплярах API — хранить их в БД.
const usage = new Map();
const bishkekDay = (now) => new Date(now + 6 * 3600e3).toISOString().slice(0, 10);

// «Разная позиция»: товарная позиция (4 цифры) для запросов по коду, группа — для дерева,
// сам текст — для поиска по названию. «8517», «8517 13», «8517130000» — одна позиция, и
// набор кода по цифрам счётчик не раздувает; набор слова по буквам — тоже (см. account).
function keysOf(fn, args) {
  const heading = (v) => {
    const d = String(v == null ? '' : v).replace(/\s+/g, '');
    return /^\d{4,}$/.test(d) ? ['h' + d.slice(0, 4)] : [];
  };
  const text = (v, p) => {
    const q = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!q) return [];
    return /^[\d ]+$/.test(q) ? heading(q) : [p + q.slice(0, 60)];
  };
  switch (fn) {
    case 'renderHtml': return text(args[0], 't');
    case 'calcCodeList': return heading(args[0]);
    case 'speciesHtml': return text(args[0], 's');
    case 'codeBundle': case 'specLookup': case 'lkRates': return (Array.isArray(args[0]) ? args[0] : []).flatMap(heading);
    case 'calcWarnings': return heading(args[0]);
    case 'treeChapter': return ['g' + String(args[0]).slice(0, 2)];
    case 'autoVariants': return ['a' + String(args[0]).slice(0, 40) + '|' + String(args[1]).slice(0, 60)];
    default: return [];
  }
}

// Возвращает код отказа или null. Считает запрос, если он пропущен.
function account(user, fn, args, now = Date.now()) {
  const day = bishkekDay(now);
  let u = usage.get(user.id);
  if (!u || u.day !== day) {
    u = { day, calls: 0, minuteStart: now, minuteCalls: 0, keys: new Set(), lastText: null, alerted: new Set() };
    usage.set(user.id, u);
  }
  if (now - u.minuteStart >= 60e3) { u.minuteStart = now; u.minuteCalls = 0; }
  if (u.minuteCalls >= LIMITS.perMinute) return 'engine_limit_minute';
  if (u.calls >= LIMITS.perDay) { alert(user, u, 'limit'); return 'engine_limit_day'; }
  let keys = keysOf(fn, args);
  // Набор слова по буквам — «с», «см», «сма»… — одна позиция: текст, продолжающий
  // предыдущий, заменяет его, а не добавляется. Только продолжение, не укорочение:
  // иначе чередование «ab», «a», «ac», «a»… считалось бы одной позицией, а продолжение
  // сужает выдачу и нового не открывает.
  const t = keys.length === 1 && /^[ts]/.test(keys[0]) ? keys[0] : null;
  let replaced = null;
  if (t && u.lastText && t !== u.lastText && t.startsWith(u.lastText)) replaced = u.lastText;
  const fresh = keys.filter((k) => !u.keys.has(k));
  if (fresh.length && u.keys.size - (replaced ? 1 : 0) + fresh.length > LIMITS.keysLimit) {
    alert(user, u, 'limit');
    return 'engine_limit_day';
  }
  if (replaced && replaced !== t) u.keys.delete(replaced);
  for (const k of fresh) u.keys.add(k);
  if (t) u.lastText = t;
  u.calls++;
  u.minuteCalls++;
  if (u.keys.size >= LIMITS.keysAlert) alert(user, u, 'many');
  return null;
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Письмо активным администраторам — не чаще раза в сутки на пользователя и повод.
function alert(user, u, kind) {
  if (u.alerted.has(kind)) return;
  u.alerted.add(kind);
  console.warn(`engine: user ${user.id} ${kind}: ${u.keys.size} positions, ${u.calls} calls today`);
  if (!process.env.RESEND_API_KEY) return;
  (async () => {
    const { rows } = await pool.query("select email from users where role = 'admin' and active = true order by created_at");
    const html = renderEmail({
      title: kind === 'limit' ? 'Пользователь упёрся в суточный лимит базы' : 'Необычно много запросов к базе',
      intro: `Учётная запись <b>${escHtml(user.email)}</b> за сегодня (по Бишкеку) открыла ${u.keys.size} разных товарных позиций`
        + ` и групп и сделала ${u.calls} запросов к базе.`
        + (kind === 'limit' ? ' Дальнейшие запросы до конца суток отклоняются.' : ` Суточный предел — ${LIMITS.keysLimit} позиций.`),
      outro: 'Так выглядит попытка выкачать базу перебором. Если это не рабочая нагрузка знакомого пользователя,'
        + ' отключите учётную запись в админ-панели.',
      footNote: 'Письмо отправлено автоматически: /api/engine, лимиты ENGINE_LIMITS.',
    });
    for (const r of rows) await sendEmail({ to: r.email, subject: `Запросы к базе: ${user.email} — ${BRAND}`, html });
  })().catch((err) => console.error('engine alert failed:', err.message));
}

router.post('/', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated', reason: req.authReason || null });
  if (!req.user.email_verified_at) return res.status(403).json({ error: 'email_not_verified' });
  const fn = req.body && req.body.fn;
  const args = Array.isArray(req.body && req.body.args) ? req.body.args.slice(0, 4) : [];
  if (!base.has(fn)) return res.status(400).json({ error: 'unknown_function' });
  // Администраторы без лимитов: сверка базы после выкладки — это как раз тысячи запросов.
  if (req.user.role !== 'admin') {
    const refused = account(req.user, fn, args);
    if (refused) return res.status(429).json({ error: refused });
  }
  let result;
  try {
    result = base.call(fn, args);
  } catch (err) {
    console.error('engine', fn, err);
    return res.status(500).json({ error: 'internal error' });
  }
  res.set('Cache-Control', 'private, no-store');
  res.json({ result });
});

module.exports = router;
module.exports.keysOf = keysOf;
module.exports.account = account;
module.exports.LIMITS = LIMITS;
module.exports.usage = usage;
