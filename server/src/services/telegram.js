// Уведомления администраторам в Telegram (24.09.2026): сбои, перебор базы, расход AI, обращения,
// оплаты, регистрации, дозор источников. Дублируют письма, а не заменяют их.
//
// Адресаты — в .env, а не в базе: TELEGRAM_BOT_TOKEN (бот от @BotFather) и TELEGRAM_ADMIN_CHAT_IDS
// (chat id через запятую; узнать — scripts/telegram-chat-id.js). Так сообщение о сбое уходит и при
// лежащем PostgreSQL, когда письмо (адресаты из users) уже не уходит. Без переменных — выключено.
//
// Отправка никогда не бросает и не задерживает запрос пользователя: notify() — «выстрелил и
// забыл», notifyAdmins() — для скриптов, которым нужно дождаться. Токен стоит в адресе запроса,
// поэтому в журнал пишется только код ответа и текст ошибки Telegram, не адрес.
const API = 'https://api.telegram.org';
const MAX_LEN = 4000; // предел Telegram — 4096 знаков

function chatIds() {
  return String(process.env.TELEGRAM_ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^-?\d{1,20}$/.test(s));
}
function enabled() {
  return !!process.env.TELEGRAM_BOT_TOKEN && chatIds().length > 0;
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Обрезка по длине не должна рвать тег: режем до разметки, затем закрываем открытые <pre>/<b>.
function clip(html) {
  if (html.length <= MAX_LEN) return html;
  let s = html.slice(0, MAX_LEN - 40);
  s = s.slice(0, Math.max(s.lastIndexOf('\n'), s.lastIndexOf('>') + 1, MAX_LEN - 200));
  s = s.replace(/<[^>]*$/, '');
  for (const t of ['pre', 'b', 'i', 'code']) {
    const open = (s.match(new RegExp('<' + t + '>', 'g')) || []).length, close = (s.match(new RegExp('</' + t + '>', 'g')) || []).length;
    if (open > close) s += '</' + t + '>';
  }
  return s + '\n…';
}

async function notifyAdmins(html) {
  if (!enabled()) return 0;
  const url = API + '/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage';
  const text = clip(String(html));
  let sent = 0;
  for (const chatId of chatIds()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) sent++;
      else console.error(`telegram: HTTP ${res.status} ${String((await res.json().catch(() => ({}))).description || '').slice(0, 200)}`);
    } catch (err) {
      console.error('telegram: ' + (err.name === 'TimeoutError' ? 'timeout' : err.message));
    }
  }
  return sent;
}

function notify(html) {
  if (enabled()) notifyAdmins(html).catch(() => {});
}

module.exports = { enabled, notify, notifyAdmins, esc, clip, chatIds };
