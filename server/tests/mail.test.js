// node server/tests/mail.test.js
// Обращения (миграция 0015): разбор письма без внешних зависимостей, приём от Cloudflare
// Email Worker и работа админки. Сети нет: база и отправка писем подменены.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { parseMessage, decodeWords, htmlToText } = require('../src/services/mailparse');

// ── Образцы писем строятся здесь же, чтобы не зашивать base64 руками ──────────────
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// cp1251 для кириллицы: А-Я → 0xC0…, а-я → 0xE0…; больше этому тесту не нужно.
const cp1251 = (s) => Buffer.from([...s].map((ch) => {
  const c = ch.codePointAt(0);
  if (c >= 0x410 && c <= 0x42f) return 0xc0 + (c - 0x410);
  if (c >= 0x430 && c <= 0x44f) return 0xe0 + (c - 0x430);
  return c & 0xff;
}));
const qp = (buf) => [...buf].map((b) => (b > 126 || b === 61 ? '=' + b.toString(16).toUpperCase().padStart(2, '0') : String.fromCharCode(b))).join('');
const crlf = (s) => s.replace(/\n/g, '\r\n');

(async () => {
  // ── 1. Разбор ────────────────────────────────────────────────────────────────
  // Простое письмо в UTF-8, тема кодированным словом, переводы строк CRLF.
  let m = parseMessage(Buffer.from(crlf(`From: Иван Петров <ivan@example.kg>
To: info@customsassist.trade
Subject: =?UTF-8?B?${b64('Вопрос по коду 8517')}?=
Message-ID: <a1@example.kg>
Date: Tue, 23 Sep 2026 10:00:00 +0600
Content-Type: text/plain; charset=utf-8

Здравствуйте! Не могу найти ставку.
Спасибо.`), 'utf8'));
  assert.deepEqual([m.from, m.fromName, m.subject, m.messageId, m.hadHtml, m.attachments.length],
    ['ivan@example.kg', 'Иван Петров', 'Вопрос по коду 8517', '<a1@example.kg>', false, 0]);
  assert.match(m.text, /Не могу найти ставку/);
  assert.match(m.text, /Спасибо\./);

  // Windows-1251 и quoted-printable: и в теме, и в теле.
  m = parseMessage(Buffer.from(crlf(`From: <shop@example.kg>
Subject: =?windows-1251?Q?${qp(cp1251('Привет'))}?=
Content-Type: text/plain; charset=windows-1251
Content-Transfer-Encoding: quoted-printable

${qp(cp1251('Здравствуйте, это письмо в кодировке Windows'))}`), 'latin1'));
  assert.equal(m.subject, 'Привет');
  assert.equal(m.text, 'Здравствуйте, это письмо в кодировке Windows');

  // Мягкий перенос строки quoted-printable: «=» в конце строки склеивает строки.
  m = parseMessage(Buffer.from(crlf(`From: a@b.kg
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

=D0=A1=D0=BB=D0=BE=D0=B2=D0=BE =\n=D0=B2=D1=82=D0=BE=D1=80=D0=BE=D0=B5`), 'latin1'));
  assert.equal(m.text, 'Слово второе');

  // multipart/alternative: берём текстовую часть, а не HTML.
  m = parseMessage(Buffer.from(crlf(`From: a@b.kg
Subject: Alt
Content-Type: multipart/alternative; boundary="BB"

--BB
Content-Type: text/plain; charset=utf-8

Текстовая часть
--BB
Content-Type: text/html; charset=utf-8

<p>HTML <b>часть</b></p>
--BB--`), 'utf8'));
  assert.deepEqual([m.text, m.hadHtml], ['Текстовая часть', true]);

  // Письмо только с HTML: разметка не сохраняется, остаётся текст.
  m = parseMessage(Buffer.from(crlf(`From: a@b.kg
Content-Type: text/html; charset=utf-8

<html><head><style>p{color:red}</style></head><body><p>Первая строка</p><p>Вторая</p>
<script>alert(1)</script></body></html>`), 'utf8'));
  assert.equal(m.text, 'Первая строка\nВторая');
  assert.ok(!/script|<p>/i.test(m.text), 'разметка не попадает в текст');
  assert.equal(m.hadHtml, true);

  // multipart/mixed с вложением: имя, тип и размер есть, содержимого нет.
  const pdf = Buffer.alloc(3000, 7).toString('base64');
  m = parseMessage(Buffer.from(crlf(`From: a@b.kg
Subject: Со вложением
Content-Type: multipart/mixed; boundary="MM"

--MM
Content-Type: text/plain; charset=utf-8

Смотрите вложение
--MM
Content-Type: application/pdf; name="=?UTF-8?B?${b64('Инвойс.pdf')}?="
Content-Disposition: attachment; filename="=?UTF-8?B?${b64('Инвойс.pdf')}?="
Content-Transfer-Encoding: base64

${pdf}
--MM--`), 'utf8'));
  assert.equal(m.text, 'Смотрите вложение');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'Инвойс.pdf');
  assert.equal(m.attachments[0].type, 'application/pdf');
  assert.ok(Math.abs(m.attachments[0].size - 3000) <= 4, 'размер вложения ' + m.attachments[0].size);
  assert.ok(!('content' in m.attachments[0]), 'содержимое вложения не сохраняется');

  // RFC 2231: имя файла отдельным полем с кодировкой.
  m = parseMessage(Buffer.from(crlf(`From: a@b.kg
Content-Type: multipart/mixed; boundary="X"

--X
Content-Type: application/octet-stream
Content-Disposition: attachment; filename*=utf-8''%D0%A1%D1%87%D1%91%D1%82.xlsx

AAAA
--X--`), 'utf8'));
  assert.equal(m.attachments[0].filename, 'Счёт.xlsx');

  // Цепочка и автоответы.
  m = parseMessage(Buffer.from(crlf(`From: a@b.kg
Message-ID: <c3@b.kg>
In-Reply-To: <a1@example.kg>
References: <root@x.kg> <a1@example.kg>
Auto-Submitted: auto-replied
Content-Type: text/plain

вне офиса`), 'utf8'));
  assert.deepEqual([m.inReplyTo, m.references[0], m.autoSubmitted], ['<a1@example.kg>', '<root@x.kg>', true]);

  // Заголовок, перенесённый на вторую строку, и два соседних кодированных слова.
  m = parseMessage(Buffer.from(crlf(`From: a@b.kg
Subject: =?UTF-8?B?${b64('Очень длинная ')}?=
 =?UTF-8?B?${b64('тема письма')}?=
Content-Type: text/plain

x`), 'utf8'));
  assert.equal(m.subject, 'Очень длинная тема письма');
  assert.equal(decodeWords('без кодирования'), 'без кодирования');
  assert.equal(htmlToText('<div>а<br>б</div>'), 'а\nб');

  // Письмо без заголовка Content-Type и с переводами строк LF.
  m = parseMessage(Buffer.from(`From: plain@b.kg\nSubject: Просто\n\nтело письма`, 'utf8'));
  assert.deepEqual([m.from, m.subject, m.text], ['plain@b.kg', 'Просто', 'тело письма']);
  console.log('PASS: разбор письма — кодированные слова, windows-1251, quoted-printable, multipart, вложения, цепочка, автоответ');

  // ── 2. Маршруты ──────────────────────────────────────────────────────────────
  process.env.APP_ORIGIN = 'https://test.local';
  process.env.SESSION_SECRET = 'local-check-only';
  process.env.MAIL_INBOUND_SECRET = 'test-inbound-secret';
  process.env.RESEND_API_KEY = 'test-key';
  process.env.MAIL_SUPPORT_FROM = 'Customs Assist KG <info@customsassist.trade>';
  delete process.env.NODE_ENV;

  const hash = bcrypt.hashSync('right-password', 4);
  const admin = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@test.local', password_hash: hash, role: 'admin',
    active: true, email_verified_at: new Date(), subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: require('./terms-version') };
  const user = { ...admin, id: '22222222-2222-4222-8222-222222222222', email: 'user@test.local', role: 'user' };
  const users = [admin, user];
  const inserted = [];
  const updates = [];
  let stored = null;
  require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => {
    if (/from users where (id|email) = \$1/.test(sql)) return { rows: users.filter((u) => u.id === args[0] || u.email === args[0]) };
    if (/from users where lower\(email\)/.test(sql)) return { rows: users.filter((u) => u.email.toLowerCase() === args[0]) };
    if (/^update users set last_login_at/.test(sql) || /^update session/.test(sql)) return { rows: [] };
    if (/insert into admin_audit_log/.test(sql)) { inserted.push(['audit', args[1]]); return { rows: [] }; }
    if (/^insert into inbox/.test(sql)) {
      inserted.push(['inbox', args]);
      stored = stored || { id: 1 };
      return { rows: [{ id: /'out'/.test(sql) ? 2 : 1, created_at: new Date() }] };
    }
    if (/^update inbox/.test(sql)) { updates.push(sql.replace(/\s+/g, ' ').slice(0, 60)); return { rows: [{ id: args[0], status: args[1] || 'done' }] }; }
    if (/from inbox m left join users u on u.id = m.user_id where m.id/.test(sql)) {
      return { rows: args[0] === 1 ? [{ id: 1, direction: 'in', from_email: 'ivan@example.kg', subject: 'Вопрос', body_text: 'текст',
        message_id: '<a1@example.kg>', thread_key: '<a1@example.kg>', status: 'new', read_at: null, attachments: [], user_id: null }] : [] };
    }
    if (/^select \* from inbox where id/.test(sql)) {
      return { rows: args[0] === 1 ? [{ id: 1, direction: 'in', from_email: 'ivan@example.kg', subject: 'Вопрос', body_text: 'текст',
        message_id: '<a1@example.kg>', thread_key: '<a1@example.kg>', to_email: 'info@customsassist.trade', user_id: null }]
        : args[0] === 2 ? [{ id: 2, direction: 'in', from_email: 'user@test.local', subject: 'Неточность в базе: 8517 13 000 0', body_text: 'текст',
          message_id: '<report-x@customsassist.trade>', thread_key: '<report-x@customsassist.trade>', to_email: 'info@customsassist.trade',
          user_id: user.id, auth_results: 'site-form' }]
        : args[0] === 9 ? [{ id: 9, direction: 'out' }] : [] };
    }
    if (/from inbox\s+where thread_key/.test(sql)) return { rows: [] };
    if (/select m.id, m.direction/.test(sql)) return { rows: [{ id: 1, subject: 'Вопрос' }] };
    if (/count\(\*\) filter \(where status = 'new'/.test(sql)) return { rows: [{ new: 1, open: 0, total: 1, month: 1 }] };
    if (/^delete from inbox where id/.test(sql)) return { rows: args[0] === 1 ? [{ from_email: 'ivan@example.kg', subject: 'Вопрос', user_id: null }] : [] };
    return { rows: [] };
  } } } };
  require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

  const app = require('../src/index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const letter = Buffer.from(crlf(`From: Иван <ivan@example.kg>
To: info@customsassist.trade
Subject: =?UTF-8?B?${b64('Вопрос')}?=
Message-ID: <a1@example.kg>
Content-Type: text/plain; charset=utf-8

Текст обращения`), 'utf8');
  const inbound = (body, headers = {}) => fetch(base + '/api/mail/inbound', { method: 'POST',
    headers: { 'content-type': 'message/rfc822', 'x-ca-secret': 'test-inbound-secret', ...headers }, body });

  const realFetch = globalThis.fetch;
  const sent = [];
  try {
    // Секрет обязателен, и ошибочный не подходит; Origin при этом не нужен вовсе.
    let r = await inbound(letter, { 'x-ca-secret': 'wrong' });
    assert.equal(r.status, 403);
    r = await fetch(base + '/api/mail/inbound', { method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: letter });
    assert.equal(r.status, 403, 'без секрета — отказ, а не проверка Origin');
    r = await inbound(Buffer.alloc(0));
    assert.equal(r.status, 400);

    // Отправитель берётся из заголовка From, а не из конверта: у рассылок в конверте стоит
    // служебный адрес для отбойников, и ответ ушёл бы туда (найдено живым письмом 23.09.2026).
    r = await inbound(letter, { 'x-ca-from': '0102abc-bounce@send.customsassist.trade', 'x-ca-to': 'info@customsassist.trade' });
    assert.equal(r.status, 200);
    assert.equal(inserted.filter((x) => x[0] === 'inbox').pop()[1][3], 'ivan@example.kg');
    // Письма без заголовка From подписываются адресом конверта.
    r = await inbound(Buffer.from('Subject: Без отправителя\r\n\r\nтекст', 'utf8'), { 'x-ca-from': 'envelope@example.kg' });
    assert.equal(r.status, 200);
    assert.equal(inserted.filter((x) => x[0] === 'inbox').pop()[1][3], 'envelope@example.kg');

    // Письмо принимается и кладётся в базу разобранным.
    r = await inbound(letter, { 'x-ca-from': 'ivan@example.kg', 'x-ca-to': 'info@customsassist.trade' });
    assert.deepEqual([r.status, (await r.json()).ok], [200, true]);
    const row = inserted.filter((x) => x[0] === 'inbox').pop()[1];
    assert.deepEqual([row[0], row[3], row[4], row[6], row[7], row[13]],
      ['<a1@example.kg>', 'ivan@example.kg', 'Иван', 'Вопрос', 'Текст обращения', 'new'], JSON.stringify(row));

    // Без входа и обычному пользователю обращения недоступны.
    assert.equal((await fetch(base + '/api/admin/mail')).status, 403);
    const login = async (email) => {
      const res = await fetch(base + '/api/auth/login', { method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://test.local' }, body: JSON.stringify({ email, password: 'right-password' }) });
      assert.equal(res.status, 200);
      return res.headers.get('set-cookie').split(';')[0];
    };
    const uc = await login(user.email);
    assert.equal((await fetch(base + '/api/admin/mail', { headers: { cookie: uc } })).status, 403);

    const ac = await login(admin.email);
    r = await fetch(base + '/api/admin/mail', { headers: { cookie: ac } });
    let j = await r.json();
    assert.deepEqual([r.status, j.counts.new, j.rows.length], [200, 1, 1]);

    // Открытие письма снимает пометку «новое».
    r = await fetch(base + '/api/admin/mail/1', { headers: { cookie: ac } });
    j = await r.json();
    assert.deepEqual([r.status, j.message.id, j.message.status], [200, 1, 'open']);
    assert.ok(updates.some((s) => /read_at = now\(\)/.test(s)), 'отметка о прочтении');
    assert.equal((await fetch(base + '/api/admin/mail/7', { headers: { cookie: ac } })).status, 404);

    // Ответ уходит через Resend в ту же цепочку письма и сохраняется исходящей строкой.
    globalThis.fetch = async (url, opts) => {
      if (String(url).startsWith('https://api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
      return realFetch(url, opts);
    };
    r = await realFetch(base + '/api/admin/mail/1/reply', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://test.local', cookie: ac }, body: JSON.stringify({ text: 'Ставка 5 %.' }) });
    assert.equal(r.status, 201);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].to, sent[0].subject, sent[0].from, sent[0].reply_to],
      ['ivan@example.kg', 'Re: Вопрос', 'Customs Assist KG <info@customsassist.trade>', 'info@customsassist.trade']);
    assert.deepEqual(sent[0].headers, { 'In-Reply-To': '<a1@example.kg>', References: '<a1@example.kg>' });
    assert.equal(sent[0].text, 'Ставка 5 %.');
    assert.match(sent[0].html, /Ставка 5 %\./);
    const out = inserted.filter((x) => x[0] === 'inbox').pop()[1];
    assert.deepEqual([out[0], out[1], out[2], out[3], out[4]],
      ['<a1@example.kg>', '<a1@example.kg>', 'info@customsassist.trade', 'ivan@example.kg', 'Re: Вопрос']);

    // Пустой ответ и ответ на исходящее письмо не отправляются.
    const reply = (id, body) => realFetch(base + `/api/admin/mail/${id}/reply`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://test.local', cookie: ac }, body: JSON.stringify(body) });
    assert.equal((await reply(1, { text: '   ' })).status, 400);
    assert.equal((await reply(1, { text: 'x'.repeat(20001) })).status, 400);
    assert.equal((await reply(9, { text: 'привет' })).status, 400);
    assert.equal(sent.length, 1, 'лишних писем не ушло');
    assert.match(sent[0].html, /Это ответ на ваше письмо на адрес info@customsassist\.trade/);
    // Сообщение «Сообщить о неточности» (routes/feedback.js, auth_results = 'site-form'): ответ в его цепочку и своя фраза, а не «ваше письмо на адрес»
    assert.equal((await reply(2, { text: 'Исправили, спасибо.' })).status, 201);
    assert.equal(sent.length, 2);
    assert.deepEqual([sent[1].to, sent[1].headers['In-Reply-To']], ['user@test.local', '<report-x@customsassist.trade>']);
    assert.match(sent[1].html, /Это ответ на ваше сообщение о неточности, отправленное из сервиса/);
    assert.doesNotMatch(sent[1].html, /ваше письмо на адрес/);

    // Статус и удаление.
    r = await realFetch(base + '/api/admin/mail/1', { method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: 'https://test.local', cookie: ac }, body: JSON.stringify({ status: 'spam' }) });
    assert.equal(r.status, 200);
    r = await realFetch(base + '/api/admin/mail/1', { method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: 'https://test.local', cookie: ac }, body: JSON.stringify({ status: 'что-то' }) });
    assert.equal(r.status, 400);
    r = await realFetch(base + '/api/admin/mail/1', { method: 'DELETE', headers: { origin: 'https://test.local', cookie: ac } });
    assert.equal(r.status, 200);
    assert.ok(inserted.some((x) => x[0] === 'audit' && x[1] === 'mail_delete'), 'удаление в журнале');
    assert.ok(inserted.some((x) => x[0] === 'audit' && x[1] === 'mail_reply'), 'ответ в журнале');
    console.log('PASS: приём письма — секрет вместо Origin, разбор в базу; админка — список, чтение, ответ в цепочку, статус, удаление, журнал');
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
