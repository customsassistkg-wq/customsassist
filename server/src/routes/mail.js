// Приём входящей почты: POST /api/mail/inbound.
//
// Единственный маршрут сервиса, который принимает данные без входа: его зовёт Cloudflare
// Email Worker (server/cloudflare/inbound-email.js), у которого сессии нет и быть не может.
// Вместо входа — общий секрет MAIL_INBOUND_SECRET в заголовке x-ca-secret, сравниваемый
// по времени постоянно. Маршрут ничего не отдаёт наружу: ответ всегда «ok» либо код ошибки,
// по нему нельзя узнать ни адрес, ни содержимое чужого письма.
//
// Проверка Origin (index.js) этот путь пропускает: у Worker нет заголовка Origin и нет
// cookie, подделать через браузер пользователя тут нечего — защищает секрет.
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { parseMessage } = require('../services/mailparse');

const router = express.Router();

// Cloudflare принимает письмо до 25 МиБ; берём с запасом на служебные заголовки.
const LIMIT = '26mb';
// Заслон на случай утечки секрета: больше сотни писем в час на этот сервис никто не шлёт.
const PER_HOUR = 100;
let windowStart = Date.now();
let inHour = 0;

const secret = () => String(process.env.MAIL_INBOUND_SECRET || '');

function secretOk(given) {
  const want = secret();
  if (!want || typeof given !== 'string' || !given) return false;
  // Хеши одинаковой длины: сравнение не выдаёт длину секрета.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

// Цепочка письма: первая ссылка из References, иначе In-Reply-To, иначе собственный
// Message-ID. Ответы из админки кладутся с тем же ключом, и переписка читается лентой.
function threadKeyOf(msg) {
  return (msg.references && msg.references[0]) || msg.inReplyTo || msg.messageId || null;
}

router.post('/inbound', express.raw({ type: () => true, limit: LIMIT }), async (req, res) => {
  if (!secret()) return res.status(503).json({ error: 'inbound not configured' });
  if (!secretOk(req.get('x-ca-secret'))) return res.status(403).json({ error: 'forbidden' });

  const now = Date.now();
  if (now - windowStart > 3600e3) { windowStart = now; inHour = 0; }
  if (++inHour > PER_HOUR) {
    console.warn('mail: inbound rate limit hit');
    return res.status(429).json({ error: 'too many messages' });
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!raw.length) return res.status(400).json({ error: 'empty body' });

  let msg;
  try {
    msg = parseMessage(raw);
  } catch (err) {
    console.error('mail: parse failed:', err.message);
    return res.status(400).json({ error: 'parse failed' });
  }
  // Отправитель — адрес из заголовка From, как его показывает любой почтовый клиент; адрес
  // конверта берётся только если заголовка нет. Наоборот делать нельзя: у рассылок и почтовых
  // служб в конверте стоит служебный адрес для отбойников (у Resend это
  // 0102…@send.customsassist.trade), и ответ из админки ушёл бы туда, а не человеку. Доверие к
  // письму даёт не этот адрес, а проверка SPF и DKIM, которую Cloudflare кладёт в
  // Authentication-Results; она сохраняется рядом.
  const isAddr = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const envelopeFrom = String(req.get('x-ca-from') || '').trim().toLowerCase();
  const from = isAddr(msg.from) ? msg.from : envelopeFrom;
  if (!isAddr(from)) return res.status(400).json({ error: 'no sender' });

  try {
    const { rows: owner } = await pool.query('select id from users where lower(email) = $1', [from]);
    const { rows } = await pool.query(
      `insert into inbox (direction, message_id, in_reply_to, thread_key, from_email, from_name, to_email, subject,
                          body_text, had_html, size_bytes, attachments, auth_results, user_id, status)
       values ('in',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [msg.messageId, msg.inReplyTo, threadKeyOf(msg), from, msg.fromName,
        String(req.get('x-ca-to') || msg.to || '').toLowerCase() || null,
        msg.subject ? msg.subject.slice(0, 500) : '(без темы)',
        msg.text ? msg.text.slice(0, 200000) : '', msg.hadHtml, raw.length,
        JSON.stringify((msg.attachments || []).slice(0, 50)), msg.authResults, owner[0] ? owner[0].id : null,
        // Автоответы и рассылки не должны выглядеть как новое обращение.
        msg.autoSubmitted ? 'done' : 'new']
    );
    console.log(`mail: stored #${rows[0].id} from ${from}, ${raw.length} bytes, ${(msg.attachments || []).length} attachments`);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('mail: store failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
module.exports.secretOk = secretOk;
module.exports.threadKeyOf = threadKeyOf;
