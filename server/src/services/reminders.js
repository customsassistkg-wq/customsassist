// Напоминания пользователям о сроке подписки (24.09.2026): письмом, раз в час, днём по Бишкеку.
//
// Оплаченная подписка — за 3 дня (окно 2–3 дня), за день (1–0 дней, «завтра»/«сегодня») и после
// окончания (1–3 дня назад). Пробный доступ (срок не дальше 4 дней от регистрации) — только за
// день и после: иначе «за 3 дня» пришло бы в день регистрации. Каждое напоминание об одном сроке
// уходит один раз: отметка в subscription_reminders вставляется до отправки, при сбое отправки
// снимается — следующий час попробует снова. Срок хранится как конец дня по UTC (как в
// админке, fmtCalDate), «сегодня» считается по Бишкеку.
//
// Как продлить, письмо говорит по тому, что есть: оплата по QR включена (xpay.enabled) — кнопка
// на сайте; нет — ответить на письмо (reply-to — адрес поддержки). Без RESEND_API_KEY или с
// REMINDERS=0 в .env — выключено.
const { pool } = require('../db');
const { sendEmail, renderEmail, BRAND } = require('./email');
const xpay = require('./xpay');

const TZ = 6 * 3600e3;
const DAY = 864e5;
const SEND_HOURS = [9, 21]; // с 9:00 до 21:00 по Бишкеку
const TRIAL_SPAN_DAYS = 4;

const origin = () => (process.env.PUBLIC_ORIGIN || (process.env.APP_ORIGIN || '').split(',')[0]).trim().replace(/\/+$/, '');
const supportFrom = () => process.env.MAIL_SUPPORT_FROM || `${BRAND} <info@customsassist.trade>`;
const supportAddress = () => (supportFrom().match(/<([^>]+)>/) || [null, supportFrom()])[1].trim();
const dmy = (d) => d.toISOString().slice(0, 10).split('-').reverse().join('.');
const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

function enabled() {
  return !!process.env.RESEND_API_KEY && process.env.REMINDERS !== '0';
}

// Какое напоминание положено сейчас: kind или null.
function dueKind(user, now = new Date()) {
  const exp = new Date(user.subscription_expires_at);
  const today = utcDay(new Date(now.getTime() + TZ));
  const daysLeft = Math.round((utcDay(exp) - today) / DAY);
  const trial = user.created_at && (exp - new Date(user.created_at)) <= TRIAL_SPAN_DAYS * DAY;
  if (daysLeft >= 2 && daysLeft <= 3 && !trial) return { kind: 'soon3', daysLeft, trial };
  if (daysLeft >= 0 && daysLeft <= 1) return { kind: 'soon1', daysLeft, trial };
  if (daysLeft >= -3 && daysLeft <= -1) return { kind: 'expired', daysLeft, trial };
  return null;
}

function plansLine() {
  const { PLANS } = require('../routes/assistant');
  return Object.values(PLANS).filter((p) => p.price > 0)
    .map((p) => `«${p.name}» — ${Number(p.price).toLocaleString('ru-RU')} сом в месяц`).join(', ');
}

function letter(user, { kind, daysLeft, trial }) {
  const date = dmy(new Date(user.subscription_expires_at));
  const what = trial ? 'Пробный доступ' : 'Подписка';
  const title = kind === 'soon3' ? `${what} заканчивается через ${daysLeft} дня`
    : kind === 'soon1' ? `${what} заканчивается ${daysLeft === 0 ? 'сегодня' : 'завтра'}`
    : `${what} закончил${trial ? 'ся' : 'ась'}`;
  const pay = xpay.enabled();
  const how = kind === 'expired'
    ? (pay ? 'Войдите на сайт с вашим адресом и паролем — на экране входа появится кнопка «Оплатить подписку». Оплата по QR из приложения любого банка Кыргызстана, доступ откроется сразу после оплаты.'
      : 'Чтобы продлить доступ, ответьте на это письмо или напишите на ' + supportAddress() + ' — мы продлим подписку.')
    : (pay ? 'Для этого войдите на сайт, нажмите на свой адрес вверху справа и выберите «Продлить подписку»: оплата по QR из приложения любого банка Кыргызстана, новый срок добавится к текущему.'
      : 'Для этого ответьте на это письмо или напишите на ' + supportAddress() + '.');
  const intro = (kind === 'expired'
    ? `${what} на ${BRAND} закончил${trial ? 'ся' : 'ась'} <b>${date}</b>. Вход в сервис закрыт до продления; ваша учётная запись и история сохранены.`
    : `${what} на ${BRAND} действует до <b>${date}</b> включительно.` + (trial ? ' Если сервис вам подошёл, выберите тариф — работа не прервётся.' : ' Чтобы работа не прервалась, продлите её заранее.'))
    + ' ' + how;
  const html = renderEmail({
    title,
    intro,
    actionUrl: origin() ? origin() + '/' : '',
    actionText: pay ? (kind === 'expired' ? 'Войти и оплатить' : 'Открыть и продлить') : 'Открыть Customs Assist KG',
    outro: 'Тарифы: ' + plansLine() + '. Продление на 3, 6 или 12 месяцев — одной оплатой.',
    footNote: 'Письмо о сроке вашей подписки отправлено автоматически. Больше одного письма о каждом этапе не придёт.',
  });
  return { subject: `${title} — ${BRAND}`, html };
}

let running = false;
async function run(now = new Date()) {
  if (!enabled() || running) return { sent: 0 };
  const hour = new Date(now.getTime() + TZ).getUTCHours();
  if (hour < SEND_HOURS[0] || hour >= SEND_HOURS[1]) return { sent: 0, night: true };
  running = true;
  let sent = 0;
  try {
    const { rows } = await pool.query(
      `select id, email, created_at, subscription_expires_at from users
        where role = 'user' and active = true and email_verified_at is not null and subscription_expires_at is not null
          and subscription_expires_at > $1::timestamptz - interval '5 days' and subscription_expires_at < $1::timestamptz + interval '5 days'
        order by subscription_expires_at`, [now]);
    for (const u of rows) {
      const due = dueKind(u, now);
      if (!due) continue;
      const expiresOn = new Date(u.subscription_expires_at).toISOString().slice(0, 10);
      const { rows: claimed } = await pool.query(
        'insert into subscription_reminders (user_id, expires_on, kind) values ($1,$2,$3) on conflict do nothing returning user_id',
        [u.id, expiresOn, due.kind]);
      if (!claimed.length) continue;
      const { subject, html } = letter(u, due);
      try {
        await sendEmail({ to: u.email, subject, html, replyTo: supportAddress() });
        sent++;
      } catch (err) {
        console.error(`reminders: ${due.kind} for ${u.id} failed: ${err.message}`);
        await pool.query('delete from subscription_reminders where user_id = $1 and expires_on = $2 and kind = $3', [u.id, expiresOn, due.kind]);
      }
    }
    if (sent) console.log(`reminders: sent ${sent}`);
  } finally {
    running = false;
  }
  return { sent };
}

function init() {
  if (!enabled()) { console.log('reminders: off (no RESEND_API_KEY or REMINDERS=0)'); return; }
  const tick = () => run().catch((err) => console.error('reminders: run failed:', err.message));
  setTimeout(tick, 60e3).unref();
  setInterval(tick, 3600e3).unref();
}

module.exports = { run, init, dueKind, letter, enabled };
