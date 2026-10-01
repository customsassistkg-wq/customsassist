// Уведомление пользователей о новой редакции правил использования (01.10.2026).
//
// Закон: об изменении пользовательского соглашения поставщик уведомляет пользователя любым доступным способом и
// устанавливает срок не менее одного месяца; соглашение считается изменённым с даты из уведомления, а кто до этой даты
// не согласился, тому оплата за неиспользованный срок возвращается (ч. 5 ст. 114 Цифрового кодекса КР от 31.07.2025
// № 178). Письмо — самый надёжный из способов: адрес есть у каждого вошедшего в базу, подтверждён и записан.
//
//   cd /opt/tnved/server && node scripts/notify-terms.js --effective 2026-12-06 \
//        --url https://customsassist.trade/terms-next.html --summary "Добавлен раздел о тарифах, оплате и возврате…"
//        — только показывает: кому, какое письмо; ничего не отправляет;
//   … --only владелец@example.com --send     — тестовое письмо одному адресу («[ТЕСТ]» в теме, в журнал не пишется);
//   … --send                                  — разослать всем действующим пользователям с подтверждённой почтой.
//
// Защита: дата вступления — не раньше чем через 31 день по Бишкеку (иначе месяц не выдержан); ссылка — только на наш
// сайт; текст «что меняется» — 20–700 знаков, обычный текст. Кому письмо уже ушло (запись terms_notice с этой датой и via scripts/notify-terms.js
// в журнале администрирования; показ блока на сайте — services/termsNotice.js — письма не заменяет), тому второе не отправляется, поэтому после сбоя команду можно повторить. По
// итогам — одно сообщение администраторам в Telegram. Содержимое правил здесь не хранится: ссылка ведёт на страницу.
const path = require('node:path');

const TZ = 6 * 3600e3;
const DAY = 864e5;

function parseArgs(argv) {
  const a = { send: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--send') a.send = true;
    else if (['--effective', '--url', '--summary', '--only'].includes(k)) a[k.slice(2)] = argv[++i];
    else throw new Error('неизвестный параметр: ' + k);
  }
  return a;
}

const origin = () => (process.env.PUBLIC_ORIGIN || (process.env.APP_ORIGIN || '').split(',')[0] || '').trim().replace(/\/+$/, '');
const supportFrom = () => process.env.MAIL_SUPPORT_FROM || 'Customs Assist KG <info@customsassist.trade>';
const supportAddress = () => (supportFrom().match(/<([^>]+)>/) || [null, supportFrom()])[1].trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dmy = (iso) => iso.split('-').reverse().join('.');

// Список ошибок параметров; пустой — можно работать.
function validate(a, now = Date.now()) {
  const errs = [];
  if (!/^\d{4}-\d\d-\d\d$/.test(a.effective || '')) errs.push('--effective ГГГГ-ММ-ДД: дата вступления новой редакции в силу');
  else {
    const today = Math.floor((now + TZ) / DAY) * DAY;
    if (Date.parse(a.effective + 'T00:00:00Z') - today < 31 * DAY) {
      errs.push('Дата вступления должна быть не раньше чем через 31 день по Бишкеку: закон требует срок не менее одного месяца (ч. 5 ст. 114 Цифрового кодекса).');
    }
  }
  const o = origin();
  if (!o) errs.push('Не задан PUBLIC_ORIGIN / APP_ORIGIN в .env');
  if (!a.url || !o || !a.url.startsWith(o + '/')) errs.push('--url: ссылка на новую редакцию на нашем сайте (' + (o || '…') + '/…)');
  if (!a.summary || a.summary.length < 20 || a.summary.length > 700) errs.push('--summary: что меняется, обычным текстом, 20–700 знаков');
  return errs;
}

function letter(a, email) {
  const date = dmy(a.effective), support = supportAddress();
  const subject = `Новая редакция правил Customs Assist KG — с ${date}`;
  const intro = `С <strong>${date}</strong> вступает в силу новая редакция правил использования сервиса «${email.BRAND}».<br><br><strong>Что меняется:</strong> ${esc(a.summary)}`;
  const outro = `Новая редакция принимается кнопкой «Принимаю» при первом входе после ${date}. Если вы не согласны с изменениями, до этой даты вы вправе отказаться от сервиса: напишите на <a href="mailto:${support}" style="color:#3A46C8">${support}</a> — соглашение будет прекращено, а оплата за неиспользованный период возвращена (часть 5 статьи 114 Цифрового кодекса Кыргызской Республики).`;
  const html = email.renderEmail({ title: 'Меняются правила использования сервиса', intro, actionUrl: esc(a.url), actionText: 'Прочитать новую редакцию', outro });
  const text = `С ${date} вступает в силу новая редакция правил использования сервиса «${email.BRAND}».\n\nЧто меняется: ${a.summary}\n\nНовая редакция: ${a.url}\n\n`
    + `Она принимается кнопкой «Принимаю» при первом входе после ${date}. Если вы не согласны с изменениями, до этой даты вы вправе отказаться от сервиса: напишите на ${support} — соглашение будет прекращено, а оплата за неиспользованный период возвращена (часть 5 статьи 114 Цифрового кодекса КР).\n`;
  return { subject, html, text };
}

// deps — для проверки без базы и без почты: { pool, email, telegram, sleep, log }
async function run(a, deps) {
  const { pool, email, telegram, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = deps;
  const L = letter(a, email);
  const test = !!a.only;
  const { rows } = test
    ? await pool.query('select id, email from users where active and lower(email) = $1', [String(a.only).toLowerCase()])
    : await pool.query('select id, email from users where active and email_verified_at is not null order by created_at');
  if (test && !rows.length) throw new Error('Нет действующей учётной записи с адресом ' + a.only);
  const res = { planned: 0, sent: 0, skipped: 0, failed: 0 };
  const todo = [];
  for (const u of rows) {
    if (!test) {
      const done = await pool.query("select 1 from admin_audit_log where action = 'terms_notice' and target_user_id = $1 and detail->>'effective' = $2 and detail->>'via' = 'scripts/notify-terms.js'", [u.id, a.effective]);
      if (done.rows.length) { res.skipped++; continue; }
    }
    todo.push(u);
  }
  res.planned = todo.length;
  log(`Тема: ${test ? '[ТЕСТ] ' : ''}${L.subject}`);
  log(`Кому: ${todo.length}${res.skipped ? ` (уже получили: ${res.skipped})` : ''} — ${todo.map((u) => u.email).slice(0, 25).join(', ')}${todo.length > 25 ? ', …' : ''}`);
  log('--- текст письма ---\n' + L.text + '--------------------');
  if (!a.send) { log('Ничего не отправлено (добавьте --send; для теста — --only адрес --send).'); return res; }
  for (const u of todo) {
    try {
      await email.sendEmail({ to: u.email, subject: (test ? '[ТЕСТ] ' : '') + L.subject, html: L.html, text: L.text, from: supportFrom(), replyTo: supportAddress() });
      if (!test) {
        await pool.query("insert into admin_audit_log (actor_id, action, target_user_id, detail) values (null, 'terms_notice', $1, $2)",
          [u.id, JSON.stringify({ email: u.email, effective: a.effective, url: a.url, via: 'scripts/notify-terms.js' })]);
      }
      res.sent++;
    } catch (e) {
      res.failed++;
      log(`НЕ ОТПРАВЛЕНО ${u.email}: ${e.message}`);
    }
    await sleep(300);
  }
  log(`Отправлено ${res.sent}, не отправлено ${res.failed}${res.skipped ? `, уже получили ${res.skipped}` : ''}.`);
  if (!test) {
    await telegram.notifyAdmins(`📣 <b>Уведомление о новой редакции правил</b>\nс ${dmy(a.effective)}: отправлено ${res.sent}, не отправлено ${res.failed}, уже получили ${res.skipped}.`).catch(() => {});
  }
  return res;
}

module.exports = { parseArgs, validate, letter, run };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const { pool } = require('../src/db');
  (async () => {
    const a = parseArgs(process.argv.slice(2));
    const errs = validate(a);
    if (errs.length) { console.error(errs.join('\n')); process.exit(2); }
    const res = await run(a, { pool, email: require('../src/services/email'), telegram: require('../src/services/telegram') });
    await pool.end();
    process.exit(res.failed ? 1 : 0);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
