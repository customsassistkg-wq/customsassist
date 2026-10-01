// node server/tests/telegram.test.js
// Уведомления администраторам в Telegram (services/telegram.js), без сети: без переменных — ничего
// не шлётся; chat id — только числа; текст экранируется; длинный обрезается без рваных тегов;
// ошибка Telegram не роняет запрос и не пишет токен в журнал. На настоящем src/index.js: новое
// обращение, регистрация и вход администратора дают сообщение, автоответ и вход пользователя — нет; в сообщении об
// обращении нет текста письма.
const assert = require('node:assert/strict');

process.env.APP_ORIGIN = 'https://test.local';
process.env.SESSION_SECRET = 'local-check-only';
process.env.MAIL_INBOUND_SECRET = 'test-inbound-secret';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_ADMIN_CHAT_IDS;

const TOKEN = '123456:SECRET-token-value';
const sent = [];
let failNext = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, opts);
  assert.equal(String(url), 'https://api.telegram.org/bot' + TOKEN + '/sendMessage');
  if (failNext) { failNext = false; return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 }); }
  sent.push(JSON.parse(opts.body));
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
const errors = [];
const realErr = console.error;
console.error = (...a) => { errors.push(a.join(' ')); };

const bcrypt = require('bcrypt');
const accounts = {
  'admin@example.kg': { id: '44444444-4444-4444-8444-444444444444', email: 'admin@example.kg', role: 'admin' },
  'user@example.kg': { id: '55555555-5555-4555-8555-555555555555', email: 'user@example.kg', role: 'user' },
};
for (const a of Object.values(accounts)) Object.assign(a, { password_hash: bcrypt.hashSync('right-password', 4), active: true,
  subscription_expires_at: null, email_verified_at: new Date(), terms_version: null });
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => {
  if (/from users where email = \$1/.test(sql)) return { rows: accounts[args[0]] ? [accounts[args[0]]] : [] };
  if (/from users where lower\(email\)/.test(sql)) return { rows: [] };
  if (/^insert into inbox/.test(sql)) return { rows: [{ id: 5 }] };
  if (/^select 1 from users where/.test(sql)) return { rows: [] };
  if (/^insert into users/.test(sql)) return { rows: [{ id: '33333333-3333-4333-8333-333333333333', email: args[0], role: 'user', active: true, subscription_expires_at: new Date() }] };
  return { rows: [] };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

const telegram = require('../src/services/telegram');
const app = require('../src/index');
const tick = () => new Promise((r) => setTimeout(r, 50));

(async () => {
  // Выключено без переменных.
  assert.equal(telegram.enabled(), false);
  assert.equal(await telegram.notifyAdmins('x'), 0);
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_ADMIN_CHAT_IDS = ' 111 ,abc, -1002, 12;drop ';
  assert.deepEqual(telegram.chatIds(), ['111', '-1002'], 'chat id — только числа');
  assert.equal(telegram.enabled(), true);

  // Экранирование и обрезка.
  assert.equal(telegram.esc('<b>&"'), '&lt;b&gt;&amp;"');
  const long = telegram.clip('<b>Заголовок</b>\n<pre>' + 'строка журнала\n'.repeat(600) + '</pre>');
  assert.ok(long.length <= 4096, 'не длиннее предела Telegram: ' + long.length);
  assert.equal((long.match(/<pre>/g) || []).length, (long.match(/<\/pre>/g) || []).length, 'теги закрыты');

  // Отправка на каждый chat id; ошибка одного — без токена в журнале и без исключения.
  failNext = true;
  assert.equal(await telegram.notifyAdmins('<b>тест</b>'), 1);
  assert.deepEqual(sent.map((m) => [m.chat_id, m.parse_mode, m.text]), [['-1002', 'HTML', '<b>тест</b>']]);
  assert.ok(errors.some((e) => /chat not found/.test(e)));
  assert.ok(!errors.some((e) => e.includes('SECRET')), 'токен не попадает в журнал');
  console.log('PASS: без переменных выключено; chat id — только числа; экранирование; обрезка без рваных тегов; ошибка без токена в журнале');

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    sent.length = 0;
    const letter = (extra) => Buffer.from(['From: Иван <ivan@example.kg>', 'To: info@customsassist.trade', 'Subject: Вопрос <срочно>', ...extra,
      'Content-Type: text/plain; charset=utf-8', '', 'СЕКРЕТНЫЙ текст обращения'].join('\r\n'), 'utf8');
    const inbound = (body) => fetch(base + '/api/mail/inbound', { method: 'POST', headers: { 'content-type': 'message/rfc822', 'x-ca-secret': 'test-inbound-secret' }, body });
    assert.equal((await inbound(letter([]))).status, 200);
    await tick();
    assert.equal(sent.length, 2, 'на оба chat id');
    assert.match(sent[0].text, /^📬 <b>Новое обращение<\/b>\nОт: Иван &lt;ivan@example\.kg&gt;\nТема: Вопрос &lt;срочно&gt;$/);
    assert.ok(!sent[0].text.includes('СЕКРЕТНЫЙ'), 'текста письма в сообщении нет');
    sent.length = 0;
    assert.equal((await inbound(letter(['Auto-Submitted: auto-replied']))).status, 200);
    await tick();
    assert.equal(sent.length, 0, 'автоответ не будит администратора');
    console.log('PASS: новое обращение — кто и тема, без текста письма; автоответ — без сообщения');

    sent.length = 0;
    const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://test.local' },
      body: JSON.stringify({ email: 'new.user@example.kg', password: 'long-enough-1' }) });
    assert.equal(r.status, 201);
    await tick();
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /^👤 <b>Новая регистрация<\/b>\nnew\.user@example\.kg — пробный доступ на 3 дн\.$/);
    console.log('PASS: регистрация — сообщение администраторам');

    // Вход администратора — сообщение (второго фактора нет); вход пользователя и неверный пароль — нет.
    const login = (email, password) => fetch(base + '/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json', origin: 'https://test.local', 'x-forwarded-for': '203.0.113.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0' } });
    sent.length = 0;
    assert.equal((await login('admin@example.kg', 'wrong-password')).status, 401);
    assert.equal((await login('user@example.kg', 'right-password')).status, 200);
    await tick();
    assert.equal(sent.length, 0, 'неверный пароль и вход пользователя — без сообщения');
    assert.equal((await login('admin@example.kg', 'right-password')).status, 200);
    await tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].text, '🔐 <b>Вход администратора</b>\nadmin@example.kg · сайт · IP 203.0.113.7 · Edge 129 Windows\n'
      + 'Если это были не вы — смените пароль в меню аккаунта и проверьте журнал администрирования.');
    console.log('PASS: вход администратора — сообщение с IP и браузером; вход пользователя и неверный пароль — без сообщения');
  } finally {
    server.close();
    console.error = realErr;
  }
})().catch((err) => {
  console.error = realErr;
  console.error(err);
  process.exit(1);
});
