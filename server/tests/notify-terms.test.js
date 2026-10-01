// node server/tests/notify-terms.test.js
// scripts/notify-terms.js — письмо о новой редакции правил (ч. 5 ст. 114 Цифрового кодекса: срок не менее месяца).
// Проверяется без базы и без почты: параметры и защита от короткого срока, текст письма (экранирование, ссылка, право отказаться),
// «только показать» по умолчанию, тестовое письмо одному адресу, рассылка с записью в журнал и повтор после сбоя.
const assert = require('node:assert/strict');

process.env.PUBLIC_ORIGIN = 'https://customsassist.trade';
process.env.MAIL_SUPPORT_FROM = 'Customs Assist KG <info@customsassist.trade>';
const notify = require('../scripts/notify-terms');
const emailSvc = require('../src/services/email');

const NOW = Date.parse('2026-10-01T12:00:00Z'); // 18:00 по Бишкеку, 1 октября
const ok = { effective: '2026-11-01', url: 'https://customsassist.trade/terms-next.html', summary: 'Добавлен раздел о тарифах, оплате и возврате; уточнён порядок отказа от сервиса.' };

// ── параметры и защита ──
assert.deepEqual(notify.parseArgs(['--effective', '2026-11-01', '--send']), { send: true, effective: '2026-11-01' });
assert.throws(() => notify.parseArgs(['--all']), /неизвестный параметр/);
assert.deepEqual(notify.validate(ok, NOW), [], 'ровно 31 день — можно');
assert.match(notify.validate({ ...ok, effective: '2026-10-31' }, NOW).join(), /31 день/, '30 дней — мало: месяц не выдержан');
assert.match(notify.validate({ ...ok, effective: '2026-10-02' }, NOW).join(), /31 день/);
assert.match(notify.validate({ ...ok, effective: 'завтра' }, NOW).join(), /ГГГГ-ММ-ДД/);
assert.match(notify.validate({ ...ok, url: 'https://evil.example/terms.html' }, NOW).join(), /--url/, 'ссылка только на наш сайт');
assert.match(notify.validate({ ...ok, url: 'https://customsassist.trade.evil.example/x' }, NOW).join(), /--url/, 'и не на похожее имя');
assert.match(notify.validate({ ...ok, summary: 'коротко' }, NOW).join(), /--summary/);
assert.match(notify.validate({ ...ok, summary: 'я'.repeat(701) }, NOW).join(), /--summary/);
// Бишкек опережает UTC на 6 часов: в 20:00 UTC там уже следующий день, и срок считается от него
assert.deepEqual(notify.validate({ ...ok, effective: '2026-11-02' }, Date.parse('2026-10-01T20:00:00Z')), [], '2 ноября от 2 октября по Бишкеку = 31 день');
assert.notDeepEqual(notify.validate({ ...ok, effective: '2026-11-01' }, Date.parse('2026-10-01T20:00:00Z')), [], '1 ноября от 2 октября по Бишкеку = 30 дней — мало');
console.log('PASS: параметры — срок не меньше 31 дня по Бишкеку, ссылка только на наш сайт, текст 20–700 знаков, незнакомый параметр отвергается');

// ── письмо ──
const L = notify.letter({ ...ok, summary: 'Добавлен раздел <b>4</b> & другие правки в тексте правил.' }, emailSvc);
assert.equal(L.subject, 'Новая редакция правил Customs Assist KG — с 01.11.2026');
assert.ok(L.html.includes('&lt;b&gt;4&lt;/b&gt; &amp; другие'), 'текст «что меняется» экранирован');
assert.ok(!L.html.includes('<b>4</b>'));
assert.ok(L.html.includes('href="https://customsassist.trade/terms-next.html"'), 'кнопка ведёт на новую редакцию');
assert.ok(L.html.includes('01.11.2026') && L.html.includes('Принимаю') && L.html.includes('info@customsassist.trade'));
assert.match(L.html, /оплата за неиспользованный период возвращена[^<]*статьи 114/, 'право отказаться и возврат названы');
assert.match(L.text, /Что меняется: Добавлен раздел <b>4<\/b> & другие/, 'в текстовой части — как есть, не разметка');
assert.match(L.text, /terms-next\.html/);
console.log('PASS: письмо — дата, что меняется (экранировано), ссылка, «Принимаю», право отказаться с возвратом, текстовая часть');

// ── рассылка ──
(async () => {
const users = [
  { id: 'u1', email: 'a@example.test' }, { id: 'u2', email: 'b@example.test' }, { id: 'u3', email: 'c@example.test' },
];
function world() {
  const audit = []; const sent = []; const tg = []; const fail = new Set(); const logs = [];
  const pool = { async query(sql, args = []) {
    if (/from users where active and lower\(email\)/.test(sql)) return { rows: users.filter((u) => u.email === args[0]) };
    if (/from users where active and email_verified_at/.test(sql)) return { rows: users.slice() };
    if (/from admin_audit_log where action = 'terms_notice'/.test(sql)) {
      assert.match(sql, /detail->>'via' = 'scripts\/notify-terms\.js'/, 'повтор определяется по записям самого скрипта');
      return { rows: audit.filter((r) => r.target === args[0] && r.detail.effective === args[1] && r.detail.via === 'scripts/notify-terms.js').map(() => ({ '?column?': 1 })) };
    }
    if (/insert into admin_audit_log/.test(sql)) { audit.push({ target: args[0], detail: JSON.parse(args[1]) }); return { rows: [] }; }
    throw new Error('неожиданный запрос: ' + sql);
  } };
  const email = { ...emailSvc, async sendEmail(m) { if (fail.has(m.to)) throw new Error('Resend: 500'); sent.push(m); return { id: 'x' }; } };
  const telegram = { async notifyAdmins(t) { tg.push(t); } };
  return { audit, sent, tg, fail, logs, deps: { pool, email, telegram, sleep: async () => {}, log: (s) => logs.push(s) } };
}
{
  // по умолчанию — только показать
  const w = world();
  w.audit.push({ target: 'u1', detail: { effective: '2026-11-01', via: 'scripts/notify-terms.js' } });
  w.audit.push({ target: 'u2', detail: { effective: '2026-11-01', via: 'banner' } }); // блок на сайте показан, а письма не было
  const r = await notify.run(ok, w.deps);
  assert.deepEqual(r, { planned: 2, sent: 0, skipped: 1, failed: 0 }, 'u1 уже получил письмо: пропущен; u2 видел только блок на сайте: письмо ему ещё нужно');
  assert.equal(w.sent.length, 0); assert.equal(w.tg.length, 0); assert.equal(w.audit.length, 2);
  assert.match(w.logs.join('\n'), /Кому: 2 \(уже получили: 1\) — b@example\.test, c@example\.test/);
  assert.match(w.logs.join('\n'), /Ничего не отправлено/);
  // тест одному адресу: «[ТЕСТ]» в теме, журнал и Telegram не трогаются, повтор не блокируется
  const t = world();
  const rt = await notify.run({ ...ok, only: 'B@example.test', send: true }, t.deps);
  assert.deepEqual(rt, { planned: 1, sent: 1, skipped: 0, failed: 0 });
  assert.equal(t.sent.length, 1); assert.equal(t.sent[0].to, 'b@example.test'); assert.match(t.sent[0].subject, /^\[ТЕСТ\] Новая редакция/);
  assert.equal(t.audit.length, 0); assert.equal(t.tg.length, 0);
  await assert.rejects(() => notify.run({ ...ok, only: 'nobody@example.test', send: true }, t.deps), /Нет действующей учётной записи/);
  console.log('PASS: без --send ничего не уходит (и видно, кому и что); --only — тестовое письмо одному адресу без записи в журнал');
}
{
  // рассылка со сбоем у одного адреса и повтором
  const w = world();
  w.fail.add('b@example.test');
  const r1 = await notify.run({ ...ok, send: true }, w.deps);
  assert.deepEqual(r1, { planned: 3, sent: 2, skipped: 0, failed: 1 });
  assert.deepEqual(w.sent.map((m) => m.to), ['a@example.test', 'c@example.test']);
  assert.deepEqual(w.audit.map((r) => r.target), ['u1', 'u3'], 'в журнале только те, кому ушло');
  assert.ok(w.audit.every((r) => r.detail.effective === '2026-11-01' && r.detail.url === ok.url && r.detail.via === 'scripts/notify-terms.js'));
  assert.equal(w.tg.length, 1); assert.match(w.tg[0], /отправлено 2, не отправлено 1, уже получили 0/);
  assert.ok(w.sent.every((m) => m.from.includes('info@customsassist.trade') && m.replyTo === 'info@customsassist.trade' && m.text && m.html));
  w.fail.clear();
  const r2 = await notify.run({ ...ok, send: true }, w.deps);
  assert.deepEqual(r2, { planned: 1, sent: 1, skipped: 2, failed: 0 }, 'повтор: двое уже получили, остался один');
  assert.deepEqual(w.sent.map((m) => m.to), ['a@example.test', 'c@example.test', 'b@example.test']);
  assert.equal(w.audit.length, 3);
  // другая дата вступления — это другое уведомление: получат все заново
  const r3 = await notify.run({ ...ok, effective: '2026-12-01', send: true }, w.deps);
  assert.deepEqual(r3, { planned: 3, sent: 3, skipped: 0, failed: 0 });
  console.log('PASS: рассылка — запись в журнал только после отправки, сбой одного адреса не останавливает остальных, повтор досылает недостающим, сообщение администраторам');
}
})().catch((e) => { console.error(e); process.exitCode = 1; });
