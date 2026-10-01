// Ошибки программы в браузере пользователя: POST /api/client-error (01.10.2026).
//
// До этого их видел только тот, у кого сломалось: кнопка регистрации однажды не работала три дня, и
// узнали об этом от пользователя. Обработчик стоит первым скриптом страницы (tnved_checker.html,
// <script data-errors>) и ловит и экран входа, и checker.js; сюда приходят текст ошибки, место в коде
// и раздел сайта. Сервер пишет строку «client-error: …» в журнал (её видно и на дашборде, раздел API)
// и о каждой новой ошибке шлёт администраторам одно сообщение в Telegram за сутки.
//
// Вход не нужен — экран входа тоже код, поэтому всё ограничено: поля обрезаются, отчётов не больше
// 20 в час с одного адреса и 300 в час всего, сообщений в Telegram — не больше 10 в сутки, ответ всегда
// 204 без подробностей. Числа от четырёх цифр (кроме номеров строк после «:»), адреса почты и параметры
// адресов вырезаются здесь, даже если браузер их уже вырезал: в журнал не должен попасть ни код из
// поиска, ни ссылка сброса пароля (privacy.html обещает, что содержимое поиска не записывается).
const express = require('express');
const telegram = require('../services/telegram');
const { browserOf } = require('../services/userAgent');

const router = express.Router();

const LIMITS = { perIp: 20, total: 300, notifyPerDay: 10 };
const IPS_MAX = 5000;
// Не ошибки сайта: сбой сети у пользователя, отменённый запрос, шум браузера и чужих скриптов.
const NOISE = /^(?:Uncaught )?(?:\w*Error: )?(?:Script error\.?|ResizeObserver loop|Failed to fetch|NetworkError when attempting|Load failed|The operation was aborted|AbortError|cancelled|Network request failed)/i;
const FOREIGN = /^(?:chrome|moz|safari|safari-web)-extension:|^webkit-masked-url:/;

let hour = -1, total = 0;
const perIp = new Map(); // ip → число отчётов за текущий час
let day = '', notifiedToday = 0;
const notified = new Set(); // подписи ошибок, о которых сегодня уже сообщено

const bishkekDay = (now) => new Date(now + 6 * 3600e3).toISOString().slice(0, 10);

function clean(value, max) {
  // Сначала обрезать, потом искать: выражения ниже (почта, blob:) на длинной строке без совпадения квадратичны —
  // 100 КБ «aaaa…» занимали процесс на 30 секунд (замер 01.10.2026), а маршрут открыт без входа.
  return String(value == null ? '' : value).slice(0, max * 2)
    // blob:https://сайт/<uuid> — это checker.js; номер строки и столбца после него остаются
    .replace(/blob:\S*?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'checker.js')
    .replace(/https?:\/\/[^\s)/]+/g, '')
    .replace(/\?[^\s):]*/g, '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/(^|[^:\w])\d[\d .]{2,}\d(?!\w)/g, '$1#')
    .replace(/\s*[\r\n]+\s*/g, ' | ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, max)
    .trim();
}

// Можно ли принять отчёт с этого адреса сейчас; считает принятый.
function admit(ip, now = Date.now()) {
  const h = Math.floor(now / 3600e3);
  if (h !== hour) {
    hour = h;
    total = 0;
    perIp.clear();
  }
  if (total >= LIMITS.total) return false;
  const n = perIp.get(ip) || 0;
  if (n >= LIMITS.perIp || (!n && perIp.size >= IPS_MAX)) return false;
  perIp.set(ip, n + 1);
  total++;
  return true;
}

function shouldNotify(signature, now = Date.now()) {
  const d = bishkekDay(now);
  if (d !== day) {
    day = d;
    notifiedToday = 0;
    notified.clear();
  }
  if (notified.has(signature) || notifiedToday >= LIMITS.notifyPerDay) return false;
  notified.add(signature);
  notifiedToday++;
  return true;
}

// Поля — только строки и числа: объект вместо строки ({toString: 1}) уронил бы String() уже после ответа.
const str = (v) => (typeof v === 'string' ? v : '');
const int = (v) => Math.max(0, Math.min(1e7, Number.isFinite(v) ? Math.floor(v) : parseInt(str(v), 10) || 0));

router.post('/', (req, res) => {
  res.status(204).end();
  // Отчёт страницы — до 3 КБ; тело больше 8 КБ — не отчёт, разбирать нечего.
  if (Number(req.get('content-length')) > 8192) return;
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const rawMsg = str(b.m).trim();
  if (!rawMsg || NOISE.test(rawMsg) || FOREIGN.test(str(b.s))) return;
  if (!admit(req.ip)) return;
  const msg = clean(rawMsg, 300);
  const src = clean(str(b.s), 120) || '?';
  const line = int(b.l);
  const col = int(b.c);
  const stack = clean(str(b.st), 1500);
  const page = str(b.p).replace(/[^\w-]/g, '').slice(0, 40) || '?';
  const kind = b.k === 'rejection' ? 'rejection' : 'error';
  const who = req.user ? `user ${req.user.id}` : 'guest';
  const browser = browserOf(req.get('user-agent'));
  console.warn(`client-error: ${who} [${page}] ${kind} ${msg} @ ${src}:${line}:${col} (${browser})${stack ? ' | ' + stack : ''}`);
  if (shouldNotify(`${msg}|${src}|${line}`)) {
    telegram.notify(`🐞 <b>Ошибка в браузере</b>\n<code>${telegram.esc(msg)}</code>\n${telegram.esc(`${src}:${line}:${col}`)} · раздел ${telegram.esc(page)} · `
      + `${req.user ? 'после входа' : 'без входа'} · ${telegram.esc(browser)}\nПовторы этой ошибки сегодня не присылаются; все — в журнале API и на дашборде.`);
  }
});

module.exports = router;
module.exports.clean = clean;
module.exports.browserOf = browserOf;
module.exports.LIMITS = LIMITS;
