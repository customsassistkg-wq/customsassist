// Запросы браузера к базе: POST /api/engine {fn, args} → {result}.
//
// С 17.09.2026 база не уходит в браузер (private/base.js только на сервере), и этот
// маршрут — единственный путь к ней для вошедшего пользователя. Отдаёт он ответ на
// один запрос, поэтому скопировать базу можно только перебором, и перебор здесь
// ограничен: по числу запросов и, главное, по числу разных товарных позиций за сутки.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { pool } = require('../db');
const base = require('../services/base');
const ops = require('../services/ops');
const { sendEmail, renderEmail, BRAND } = require('../services/email');
const telegram = require('../services/telegram');

const router = express.Router();

// Поиск идёт по мере набора кода, поэтому человек за работой делает десятки запросов в
// минуту, но за день открывает десятки, от силы сотни товарных позиций, а не 1 200
// позиций ЕТТ и не все сочетания букв для поиска по названию. keysAlert — письмо
// администраторам, keysLimit и perDay — отказ до конца суток по Бишкеку.
// Переопределение: ENGINE_LIMITS={"perMinute":120,"perDay":5000,"keysAlert":300,"keysLimit":800}.
const LIMITS = { perMinute: 120, perDay: 5000, keysAlert: 300, keysLimit: 800,
  ...(process.env.ENGINE_LIMITS ? JSON.parse(process.env.ENGINE_LIMITS) : {}) };

// Счётчики — в памяти одного процесса, а копия раз в пять секунд и при остановке ложится в файл
// (saveState, init): до 01.10.2026 каждый перезапуск API обнулял их, а 30.09.2026 база выкладывалась
// двадцать раз — суточный предел начинался заново после каждой выкладки. При нескольких экземплярах
// API хранить их в БД.
const usage = new Map();
const bishkekDay = (now) => new Date(now + 6 * 3600e3).toISOString().slice(0, 10);

// Позиция хранится не текстом, а меткой — HMAC с ключом из SESSION_SECRET: для подсчёта разных позиций
// нужна только проверка «уже была», а в файле на диске не остаётся ни кодов, ни поисковых фраз
// (privacy.html обещает, что содержимое поиска не записывается). Без SESSION_SECRET (тесты) ключ
// случайный на процесс — метки тогда переживают только перезапуск внутри процесса.
const TAG_KEY = process.env.SESSION_SECRET
  ? crypto.createHmac('sha256', process.env.SESSION_SECRET).update('engine-usage-v1').digest()
  : crypto.randomBytes(32);
const tag = (key) => crypto.createHmac('sha256', TAG_KEY).update(key).digest('base64url').slice(0, 16);

// «Разная позиция»: товарная позиция (4 цифры) для запросов по коду, группа — для дерева,
// сам текст — для поиска по названию. «8517», «8517 13», «8517130000» — одна позиция, и
// набор кода по цифрам счётчик не раздувает; набор слова по буквам — тоже (см. account).
// Позиция берётся по цифрам запроса, где бы они ни стояли: база сама вынимает код из
// «8517.13», «85.17» и из «……8517» (findX и calcCodeList отбрасывают нецифры). До 21.09.2026
// ключом такого запроса были только первые 60 знаков текста, а у calcCodeList — ничего:
// 60 точек перед кодом открывали все 1 228 позиций ЕТТ одним ключом и без письма.
function keysOf(fn, args) {
  const heading = (v) => {
    const d = String(v == null ? '' : v).replace(/\D/g, '');
    return d.length >= 4 ? ['h' + d.slice(0, 4)] : [];
  };
  const text = (v, p) => {
    const q = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!q) return [];
    return /^[\d ]+$/.test(q) ? heading(q) : [p + q.slice(0, 60), ...heading(q)];
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
  const keys = keysOf(fn, args);
  // Набор слова по буквам — «с», «см», «сма»… — одна позиция: текст, продолжающий
  // предыдущий, заменяет его, а не добавляется. Только продолжение, не укорочение:
  // иначе чередование «ab», «a», «ac», «a»… считалось бы одной позицией, а продолжение
  // сужает выдачу и нового не открывает. Сам текст (lastText) живёт только в памяти;
  // после перезапуска первое продолжение просто считается новой позицией.
  const t = keys.find((k) => /^[ts]/.test(k)) || null;
  let replaced = null;
  if (t && u.lastText && t !== u.lastText && t.startsWith(u.lastText)) replaced = tag(u.lastText);
  // Две строки одной позиции в одном запросе (codeBundle по 8517 13 и 8517 12) — одна новая позиция.
  const fresh = [...new Set(keys.map(tag))].filter((k) => !u.keys.has(k));
  if (fresh.length && u.keys.size - (replaced && u.keys.has(replaced) ? 1 : 0) + fresh.length > LIMITS.keysLimit) {
    alert(user, u, 'limit');
    return 'engine_limit_day';
  }
  if (replaced) u.keys.delete(replaced);
  for (const k of fresh) u.keys.add(k);
  if (t) u.lastText = t;
  u.calls++;
  u.minuteCalls++;
  dirty = true;
  if (u.keys.size >= LIMITS.keysAlert) alert(user, u, 'many');
  return null;
}

// ── Счётчики на диске: переживают перезапуск API ──
// Файл — server/var/engine-usage.json (OPS_STATE_DIR, как у разбора находок; ENGINE_STATE_FILE — свой путь):
// только текущие сутки по Бишкеку, на каждую учётную запись — число запросов, метки позиций и какие
// письма уже ушли. Пишется не чаще раза в пять секунд и при остановке процесса (index.js), через
// переименование, с правами 600; с наступлением новых суток в Бишкеке вчерашние счётчики удаляются
// и из памяти, и из файла. Пишет и читает только init(): тесты и require из других скриптов файла не касаются.
let dirty = false;
let savedDay = null;
let timer = null;
const stateFile = () => process.env.ENGINE_STATE_FILE || path.join(ops.dir(), 'engine-usage.json');

function saveState(now = Date.now()) {
  const day = bishkekDay(now);
  for (const [id, u] of usage) if (u.day !== day) usage.delete(id);
  if (!dirty && savedDay === day) return false;
  const users = [];
  for (const [id, u] of usage) users.push([id, { calls: u.calls, keys: [...u.keys], alerted: [...u.alerted] }]);
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, day, users }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  dirty = false;
  savedDay = day;
  return true;
}

// Возвращает, у скольких учётных записей восстановлен счёт. Чужие сутки, битый файл, неизвестная версия — ноль.
function loadState(now = Date.now()) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return 0;
  }
  const day = bishkekDay(now);
  if (!s || s.v !== 1 || s.day !== day || !Array.isArray(s.users)) return 0;
  let n = 0;
  for (const entry of s.users) {
    const [id, x] = Array.isArray(entry) ? entry : [];
    if (typeof id !== 'string' || !x || !Array.isArray(x.keys)) continue;
    const u = usage.get(id);
    const keys = x.keys.filter((k) => typeof k === 'string');
    const alerted = (Array.isArray(x.alerted) ? x.alerted : []).filter((k) => typeof k === 'string');
    if (u && u.day === day) {
      // Запросы, пришедшие раньше чтения файла, складываются с сохранёнными.
      u.calls += Number(x.calls) || 0;
      for (const k of keys) u.keys.add(k);
      for (const k of alerted) u.alerted.add(k);
    } else {
      usage.set(id, { day, calls: Number(x.calls) || 0, minuteStart: now, minuteCalls: 0, keys: new Set(keys), lastText: null, alerted: new Set(alerted) });
    }
    n++;
  }
  savedDay = day;
  return n;
}

function init() {
  const n = loadState();
  if (n) console.log(`engine: usage restored for ${n} accounts`);
  let failing = false; // о сбое записи (диск, права) — одна строка журнала до восстановления, а не каждые пять секунд
  const tick = () => {
    try {
      saveState();
      if (failing) console.log('engine: usage saved again');
      failing = false;
    } catch (err) {
      if (!failing) console.error('engine: usage not saved:', err.message);
      failing = true;
    }
  };
  clearInterval(timer);
  timer = setInterval(tick, 5000);
  timer.unref();
  return tick;
}
const stop = () => clearInterval(timer);

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Письмо активным администраторам — не чаще раза в сутки на пользователя и повод.
function alert(user, u, kind) {
  if (u.alerted.has(kind)) return;
  u.alerted.add(kind);
  dirty = true;
  console.warn(`engine: user ${user.id} ${kind}: ${u.keys.size} positions, ${u.calls} calls today`);
  telegram.notify((kind === 'limit' ? '⛔ <b>Суточный лимит базы исчерпан</b>' : '⚠️ <b>Необычно много запросов к базе</b>')
    + `\n${telegram.esc(user.email)}: ${u.keys.size} позиций, ${u.calls} запросов за сегодня.`
    + (kind === 'limit' ? ' Запросы до конца суток отклоняются.' : ` Предел — ${LIMITS.keysLimit}.`));
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
module.exports.tag = tag;
module.exports.init = init;
module.exports.stop = stop;
module.exports.saveState = saveState;
module.exports.loadState = loadState;
