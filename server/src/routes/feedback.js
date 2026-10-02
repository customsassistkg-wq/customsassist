// «Сообщить о неточности» (02.10.2026): POST /api/feedback. Вошедший пользователь с подтверждённым адресом пишет, что в
// результате поиска не так (ставка, мера, срок, нет нужной карточки). Сообщение кладётся в «Обращения» (таблица inbox) как
// входящее письмо с пометкой auth_results = 'site-form': администраторы читают его там же, где почту info@, и отвечают из
// админ-панели — ответ уходит на адрес учётной записи в той же цепочке (routes/admin.js). Своей таблицы и своего экрана нет.
//
// Что хранится: текст сообщения, код, название выбранной карточки, условия поиска (направление, страна, дата) и адрес
// учётной записи — год с даты сообщения (inbox.purge_after, как у писем), удаляется очисткой services/retention.js.
// Названо в privacy.html («Письма в службу поддержки»). В Telegram уходит «Новое обращение»: от кого и тема, без текста.
//
// Заслон: не больше 3 сообщений в час и 10 в сутки на пользователя (счёт по таблице, поэтому он переживает перезапуск);
// то же сообщение того же пользователя в течение суток второй раз не записывается.
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const telegram = require('../services/telegram');

const router = express.Router();

const MIN = 10;
const MAX = 1500;
const PER_HOUR = 3;
const PER_DAY = 10;
const DIRS = { im: 'ввоз', ex: 'вывоз', tr: 'транзит' };

function guard(req, res) {
  if (!req.user) { res.status(401).json({ error: 'not authenticated', reason: req.authReason || null }); return false; }
  if (!req.user.email_verified_at) { res.status(403).json({ error: 'email_not_verified' }); return false; }
  return true;
}

const supportAddress = () => {
  const from = process.env.MAIL_SUPPORT_FROM || 'Customs Assist KG <info@customsassist.trade>';
  return (from.match(/<([^>]+)>/) || [null, from])[1].trim();
};
const fmtCode = (c) => (/^\d{10}$/.test(c) ? `${c.slice(0, 4)} ${c.slice(4, 6)} ${c.slice(6, 9)} ${c.slice(9)}` : c);
// Текст пользователя: без управляющих знаков (кроме перевода строки и табуляции), переводы строк — \n, края обрезаны.
// Управляющие знаки и разделители строк Юникода (коды 0x2028 и 0x2029) собираются из кодов: запись их литералом ломалась при сохранении файла.
const CTRL = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [127, 127], [0x2028, 0x2029]].map(([a, b]) => String.fromCharCode(a) + (b > a ? '-' + String.fromCharCode(b) : '')).join('') + ']', 'g');
const clean = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(CTRL, '').trim().slice(0, max);
const oneLine = (v, max) => clean(v, max).replace(/\s+/g, ' ');

router.post('/', async (req, res, next) => {
  if (!guard(req, res)) return;
  try {
    const b = req.body || {};
    const text = clean(b.text, MAX + 1);
    if (typeof b.text !== 'string' || text.length < MIN) return res.status(400).json({ error: 'text too short', min: MIN });
    if (text.length > MAX) return res.status(400).json({ error: 'text too long', max: MAX });
    const code = String(b.code == null ? '' : b.code).replace(/[\s.\-]/g, '');
    if (code && !/^\d{4,10}$/.test(code)) return res.status(400).json({ error: 'bad code' });
    const dir = b.dir == null || b.dir === '' ? '' : String(b.dir);
    if (dir && !DIRS[dir]) return res.status(400).json({ error: 'bad direction' });
    const date = b.date == null || b.date === '' ? '' : String(b.date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    const country = oneLine(b.country, 80);
    const card = oneLine(b.card, 200);

    const uid = req.user.id;
    const { rows: [n] } = await pool.query(
      `select count(*) filter (where created_at > now() - interval '1 hour')::int as hour, count(*)::int as day
         from inbox where user_id = $1 and auth_results = 'site-form' and direction = 'in' and created_at > now() - interval '1 day'`, [uid]);
    const body = [text, '', '———', 'Сообщение отправлено кнопкой «Сообщить о неточности» в сервисе.',
      code ? 'Код: ' + fmtCode(code) : 'Код: не указан',
      'Карточка: ' + (card || 'ко всему результату / нужной карточки нет'),
      'Условия поиска: ' + [dir ? DIRS[dir] : DIRS.im, country || 'страна не выбрана', date ? 'на ' + date : 'на день отправки'].join(' · ')].join('\n');
    const { rows: [dup] } = await pool.query(
      `select 1 as x from inbox where user_id = $1 and auth_results = 'site-form' and direction = 'in'
          and created_at > now() - interval '1 day' and body_text = $2`, [uid, body]);
    if (dup) return res.json({ ok: true, duplicate: true });
    if (n.hour >= PER_HOUR || n.day >= PER_DAY) return res.status(429).json({ error: 'too many reports' });

    const subject = ('Неточность в базе: ' + (code ? fmtCode(code) : 'без кода') + (card ? ' — ' + card : '')).slice(0, 300);
    const messageId = `<report-${crypto.randomUUID()}@customsassist.trade>`;
    const { rows: [row] } = await pool.query(
      `insert into inbox (direction, message_id, thread_key, from_email, to_email, subject, body_text, had_html, size_bytes,
                          attachments, auth_results, user_id, status)
       values ('in', $1, $1, $2, $3, $4, $5, false, $6, '[]', 'site-form', $7, 'new') returning id`,
      [messageId, String(req.user.email).toLowerCase(), supportAddress(), subject, body, Buffer.byteLength(body), uid]);
    console.log(`feedback: stored #${row.id} from user ${uid}`);
    telegram.notify('📬 <b>Новое обращение</b> (кнопка «Сообщить о неточности»)\nОт: ' + telegram.esc(req.user.email)
      + ' (есть учётная запись)\nТема: ' + telegram.esc(subject.slice(0, 200)));
    res.status(201).json({ ok: true, id: row.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.LIMITS = { MIN, MAX, PER_HOUR, PER_DAY };
