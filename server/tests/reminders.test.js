// node server/tests/reminders.test.js
// Напоминания о сроке подписки (services/reminders.js, миграция 0017), без сети и базы: какое
// напоминание положено в какой день (оплаченная подписка — за 3 дня, за день, после; пробный
// доступ — без «за 3 дня»); ночью по Бишкеку писем нет; одно напоминание об одном сроке — один раз;
// сбой отправки снимает отметку и следующий запуск повторяет; как продлить — по тому, включена ли
// оплата; ответ на письмо идёт в поддержку.
const assert = require('node:assert/strict');

process.env.RESEND_API_KEY = 'test-key';
process.env.APP_ORIGIN = 'https://customsassist.trade';
delete process.env.XPAY_CLIENT_ID;
delete process.env.XPAY_CLIENT_SECRET;
delete process.env.REMINDERS;

const marks = new Set();
let users = [];
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, a) => {
  sql = sql.replace(/\s+/g, ' ').trim();
  if (/^select id, email, created_at, subscription_expires_at from users/.test(sql)) {
    assert.match(sql, /role = 'user' and active = true and email_verified_at is not null/);
    return { rows: users };
  }
  if (/^insert into subscription_reminders/.test(sql)) {
    const k = a.join('|');
    if (marks.has(k)) return { rows: [] };
    marks.add(k); return { rows: [{ user_id: a[0] }] };
  }
  if (/^delete from subscription_reminders where user_id/.test(sql)) { marks.delete(a.join('|')); return { rows: [] }; }
  return { rows: [] };
} } } };

const mails = [];
let failFor = null;
globalThis.fetch = async (url, opts) => {
  assert.equal(String(url), 'https://api.resend.com/emails');
  const body = JSON.parse(opts.body);
  if (failFor && body.to === failFor) { failFor = null; return new Response('{"message":"boom"}', { status: 500 }); }
  mails.push(body);
  return new Response('{"id":"x"}', { status: 200 });
};
const errs = [];
console.error = (...m) => errs.push(m.join(' '));
console.log = () => {};

const r = require('../src/services/reminders');
const NOW = new Date('2026-09-24T06:00:00Z'); // 12:00 по Бишкеку
const exp = (days) => new Date(Date.UTC(2026, 8, 24 + days, 23, 59, 59, 999)).toISOString();
const paid = (id, days) => ({ id, email: id + '@x.kg', created_at: '2026-06-01T00:00:00Z', subscription_expires_at: exp(days) });

(async () => {
  // Какое напоминание в какой день.
  const k = (u) => (r.dueKind(u, NOW) || {}).kind || null;
  assert.deepEqual([4, 3, 2, 1, 0, -1, -3, -4].map((d) => k(paid('p', d))), [null, 'soon3', 'soon3', 'soon1', 'soon1', 'expired', 'expired', null]);
  const trial = (d) => ({ id: 't', email: 't@x.kg', created_at: new Date(Date.parse(exp(d)) - 3 * 864e5).toISOString(), subscription_expires_at: exp(d) });
  assert.deepEqual([3, 2, 1, 0, -1].map((d) => k(trial(d))), [null, null, 'soon1', 'soon1', 'expired'], 'пробному — без «за 3 дня»');
  console.log = (...m) => process.stdout.write(m.join(' ') + '\n');
  console.log('PASS: оплаченной — за 3 дня, за день, после; пробному — без «за 3 дня»; раньше и позже — ничего');

  // Ночью не пишем.
  users = [paid('a', 3)];
  assert.deepEqual(await r.run(new Date('2026-09-24T20:00:00Z')), { sent: 0, night: true }); // 02:00 по Бишкеку
  assert.equal(mails.length, 0);

  // Днём — по одному письму на пользователя, повторный запуск ничего не шлёт.
  users = [paid('a', 3), paid('b', 1), paid('c', 0), paid('d', -2), paid('e', 10)];
  assert.equal((await r.run(NOW)).sent, 4);
  assert.deepEqual(mails.map((m) => [m.to, m.subject]), [
    ['a@x.kg', 'Подписка заканчивается через 3 дня — Customs Assist KG'],
    ['b@x.kg', 'Подписка заканчивается завтра — Customs Assist KG'],
    ['c@x.kg', 'Подписка заканчивается сегодня — Customs Assist KG'],
    ['d@x.kg', 'Подписка закончилась — Customs Assist KG'],
  ]);
  assert.equal(mails[0].reply_to, 'info@customsassist.trade');
  assert.match(mails[0].html, /действует до <b>27\.09\.2026<\/b>/);
  assert.match(mails[0].html, /ответьте на это письмо/, 'оплата выключена — продление через поддержку');
  assert.match(mails[0].html, /«Базовый» — 490 сом в месяц/);
  mails.length = 0;
  assert.equal((await r.run(NOW)).sent, 0, 'повторно не шлёт');
  console.log('PASS: ночью молчит; днём — одно письмо на этап, повтор ничего не шлёт; срок, тарифы, ответ в поддержку');

  // Сбой отправки — отметка снимается, следующий запуск повторяет.
  users = [paid('f', 2)];
  failFor = 'f@x.kg';
  assert.equal((await r.run(NOW)).sent, 0);
  assert.ok(errs.some((e) => /reminders: soon3 for f failed/.test(e)));
  assert.equal((await r.run(NOW)).sent, 1);
  console.log('PASS: сбой отправки — отметка снята, следующий запуск отправил');

  // Оплата включена — письмо ведёт к кнопке оплаты; продление — новый срок, новые напоминания.
  process.env.XPAY_CLIENT_ID = 'x'; process.env.XPAY_CLIENT_SECRET = 'y';
  mails.length = 0;
  users = [paid('g', -1), paid('h', 3)];
  await r.run(NOW);
  assert.match(mails[0].html, /появится кнопка «Оплатить подписку»/);
  assert.match(mails[1].html, /выберите «Продлить подписку»/);
  mails.length = 0;
  users = [paid('h', 3 + 30)]; // продлил на месяц — «за 3 дня» о новом сроке придёт в своё время
  assert.equal((await r.run(NOW)).sent, 0);
  users = [{ ...paid('h', 3), subscription_expires_at: exp(3) }];
  assert.equal((await r.run(NOW)).sent, 0, 'о прежнем сроке второй раз не пишет');
  console.log('PASS: при включённой оплате — кнопки «Оплатить» / «Продлить подписку»; о каждом сроке — один раз');

  // Выключатель.
  process.env.REMINDERS = '0';
  assert.equal(r.enabled(), false);
})().catch((err) => {
  process.stdout.write(String(err && err.stack || err) + '\n');
  process.exit(1);
});
