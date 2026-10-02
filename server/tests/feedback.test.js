// node server/tests/feedback.test.js
// «Сообщить о неточности» (routes/feedback.js, кнопка и окно в checker.js) на настоящем src/index.js с подменённой таблицей inbox:
// только вошедшему с подтверждённым адресом; текст 10–1500 знаков, код, направление и дата проверяются; сообщение ложится в
// «Обращения» входящим письмом с пометкой site-form (тема с кодом и карточкой, в теле — текст и условия поиска), администратору
// уходит «Новое обращение» без текста; управляющие знаки вырезаны; повтор того же текста за сутки не пишется; не больше 3 в час
// и 10 в сутки. С PLAYWRIGHT_MODULE — браузер: кнопка в шапке результата, окно с карточками на экране, отказ на короткий текст,
// отправка с выбранной карточкой, телефон без горизонтальной прокрутки, выход закрывает окно.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

// Вне диапазона временных портов и Linux (32768–60999), и Windows (49152–65535): в нём порт иногда занят
// исходящим соединением, и тест падал с EADDRINUSE (01.10.2026, после браузерных тестов).
const PORT = 23000 + Math.floor(Math.random() * 1000);
process.env.APP_ORIGIN = 'https://test.local,http://127.0.0.1:' + PORT;
process.env.SESSION_SECRET = 'local-check-only';
process.env.RESEND_API_KEY = 'test-key';
delete process.env.NODE_ENV;
delete process.env.TELEGRAM_BOT_TOKEN;

const hash = bcrypt.hashSync('right-password', 4);
const mk = (id, email, extra = {}) => ({ id, email, password_hash: hash, role: 'user', active: true, email_verified_at: new Date(),
  subscription_expires_at: '2099-01-01T23:59:59.999Z', last_seen_at: new Date(), ai_plan: 'base', terms_version: '2026-09-18', ...extra });
const user = mk('22222222-2222-4222-8222-222222222222', 'user@test.local');
const fresh = mk('44444444-4444-4444-8444-444444444444', 'fresh@test.local', { email_verified_at: null });
const users = [user, fresh];
let inbox = []; // { id, user_id, from_email, to_email, subject, body_text, message_id, thread_key, auth_results, direction, status, created_at }
let nextId = 1;

require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, a = []) => {
  sql = sql.replace(/\s+/g, ' ').trim();
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: users.filter((u) => u.id === a[0] || u.email === a[0]).map((u) => ({ ...u })) };
  if (/^select count\(\*\) filter \(where created_at > now\(\) - interval '1 hour'\)::int as hour, count\(\*\)::int as day from inbox/.test(sql)) {
    const mine = inbox.filter((m) => m.user_id === a[0] && m.auth_results === 'site-form' && m.direction === 'in' && Date.now() - m.created_at.getTime() < 86400e3);
    return { rows: [{ hour: mine.filter((m) => Date.now() - m.created_at.getTime() < 3600e3).length, day: mine.length }] };
  }
  if (/^select 1 as x from inbox where user_id = \$1 and auth_results = 'site-form'/.test(sql)) {
    return { rows: inbox.filter((m) => m.user_id === a[0] && m.auth_results === 'site-form' && Date.now() - m.created_at.getTime() < 86400e3 && m.body_text === a[1]).map(() => ({ x: 1 })) };
  }
  if (/^insert into inbox \(direction, message_id, thread_key, from_email, to_email, subject, body_text, had_html, size_bytes, attachments, auth_results, user_id, status\) values \('in', \$1, \$1, \$2, \$3, \$4, \$5, false, \$6, '\[\]', 'site-form', \$7, 'new'\)/.test(sql)) {
    const row = { id: nextId++, direction: 'in', message_id: a[0], thread_key: a[0], from_email: a[1], to_email: a[2], subject: a[3], body_text: a[4], size_bytes: a[5],
      auth_results: 'site-form', user_id: a[6], status: 'new', created_at: new Date() };
    inbox.push(row);
    return { rows: [{ id: row.id }] };
  }
  return { rows: [] };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

const telegram = require('../src/services/telegram');
const tg = [];
telegram.notify = (m) => { tg.push(m); };
const quiet = console.log;
const app = require('../src/index');

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + PORT;
  const hdr = { 'content-type': 'application/json', origin: 'https://test.local' };
  const login = (email) => fetch(base + '/api/auth/login', { method: 'POST', headers: hdr, body: JSON.stringify({ email, password: 'right-password' }) });
  const send = (cookie, body) => fetch(base + '/api/feedback', { method: 'POST', headers: { ...hdr, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const TEXT = 'По этому коду ставка уже 5 %, а не 10 % — Решение Коллегии № 112.';
  try {
    // Вход и подтверждённый адрес обязательны.
    assert.equal((await send(null, { text: TEXT })).status, 401);
    let r = await login(fresh.email);
    const fc = (r.headers.get('set-cookie') || '').split(';')[0];
    if (r.status === 200 && fc) assert.equal((await send(fc, { text: TEXT })).status, 403);
    r = await login(user.email);
    assert.equal(r.status, 200);
    const uc = r.headers.get('set-cookie').split(';')[0];

    // Проверка полей: ничего не записано.
    console.log = () => {};
    for (const [body, field] of [
      [{ text: 'коротко' }, 'text too short'], [{ text: 123456789012 }, 'text too short'], [{}, 'text too short'],
      [{ text: 'x'.repeat(1501) }, 'text too long'], [{ text: TEXT, code: '12' }, 'bad code'], [{ text: TEXT, code: '85171300xx' }, 'bad code'],
      [{ text: TEXT, dir: 'sideways' }, 'bad direction'], [{ text: TEXT, date: '02.10.2026' }, 'bad date'],
    ]) {
      r = await send(uc, body);
      assert.deepEqual([r.status, (await r.json()).error], [400, field], JSON.stringify(body).slice(0, 60));
    }
    console.log = quiet;
    assert.equal(inbox.length, 0);

    // Сообщение ложится в «Обращения» входящим письмом; управляющие знаки вырезаны, переводы строк приведены к \n.
    console.log = () => {};
    r = await send(uc, { text: TEXT + '\r\nВторая\u0007 строка\u0000.', code: '8517 13 000 0', dir: 'ex', country: ' Китай ', date: '2026-10-02',
      card: 'Вывозная таможенная пошлина\n Кыргызской Республики' });
    console.log = quiet;
    assert.equal(r.status, 201);
    assert.equal(inbox.length, 1);
    const m = inbox[0];
    assert.deepEqual([m.direction, m.status, m.auth_results, m.user_id, m.from_email, m.to_email],
      ['in', 'new', 'site-form', user.id, 'user@test.local', 'info@customsassist.trade']);
    assert.match(m.message_id, /^<report-[0-9a-f-]{36}@customsassist\.trade>$/);
    assert.equal(m.thread_key, m.message_id);
    assert.equal(m.subject, 'Неточность в базе: 8517 13 000 0 — Вывозная таможенная пошлина Кыргызской Республики');
    assert.ok(m.body_text.startsWith(TEXT + '\nВторая строка.'), m.body_text.slice(0, 120));
    assert.doesNotMatch(m.body_text, /[\u0000-\u0008\r]/);
    assert.match(m.body_text, /\nКод: 8517 13 000 0\n/);
    assert.match(m.body_text, /\nКарточка: Вывозная таможенная пошлина Кыргызской Республики\n/);
    assert.match(m.body_text, /\nУсловия поиска: вывоз · Китай · на 2026-10-02$/);
    assert.equal(m.size_bytes, Buffer.byteLength(m.body_text));
    // Администратору — кто и о чём, без текста.
    assert.equal(tg.length, 1);
    assert.match(tg[0], /Новое обращение/);
    assert.ok(tg[0].includes('user@test.local'));
    assert.match(tg[0], /Неточность в базе: 8517 13 000 0/);
    assert.doesNotMatch(tg[0], /Решение Коллегии|ставка уже 5/);
    console.log('PASS: сообщение — только вошедшему с подтверждённым адресом, поля проверяются, в «Обращения» входящим с site-form, тема с кодом и карточкой, управляющие знаки вырезаны, в Telegram без текста');

    // Тот же текст за сутки второй раз не пишется; код и карточка не обязательны.
    console.log = () => {};
    r = await send(uc, { text: TEXT + '\r\nВторая\u0007 строка\u0000.', code: '8517 13 000 0', dir: 'ex', country: 'Китай', date: '2026-10-02', card: 'Вывозная таможенная пошлина\n Кыргызской Республики' });
    assert.deepEqual([r.status, (await r.json()).duplicate], [200, true]);
    assert.equal(inbox.length, 1);
    r = await send(uc, { text: 'Нет нужной меры по этому товару.' });
    console.log = quiet;
    assert.equal(r.status, 201);
    assert.equal(inbox[1].subject, 'Неточность в базе: без кода');
    assert.match(inbox[1].body_text, /\nКод: не указан\nКарточка: ко всему результату \/ нужной карточки нет\nУсловия поиска: ввоз · страна не выбрана · на день отправки$/);

    // Заслон: третье в течение часа проходит, четвёртое — нет; через два часа снова можно; в сутки не больше десяти.
    console.log = () => {};
    assert.equal((await send(uc, { text: 'Третье сообщение за час, текст другой.' })).status, 201);
    r = await send(uc, { text: 'Четвёртое сообщение за час, текст другой.' });
    assert.deepEqual([r.status, (await r.json()).error], [429, 'too many reports']);
    for (const x of inbox) x.created_at = new Date(Date.now() - 2 * 3600e3);
    assert.equal((await send(uc, { text: 'Через два часа, текст другой, раз.' })).status, 201);
    assert.equal((await send(uc, { text: 'Через два часа, текст другой, два.' })).status, 201);
    assert.equal((await send(uc, { text: 'Через два часа, текст другой, три.' })).status, 201);
    for (const x of inbox) x.created_at = new Date(Date.now() - 4 * 3600e3);
    for (let k = 0; k < 3; k++) assert.equal((await send(uc, { text: 'Ещё одно сообщение другого дня, номер ' + k + '.' })).status, 201);
    assert.equal(inbox.length, 9, 'девять за сутки');
    for (const x of inbox) x.created_at = new Date(Date.now() - 6 * 3600e3);
    assert.equal((await send(uc, { text: 'Десятое за сутки, текст другой, ровно десять.' })).status, 201);
    r = await send(uc, { text: 'Одиннадцатое за сутки, текст другой, лишнее.' });
    assert.deepEqual([r.status, (await r.json()).error], [429, 'too many reports']);
    for (const x of inbox) x.created_at = new Date(Date.now() - 25 * 3600e3);
    assert.equal((await send(uc, { text: 'Следующие сутки, текст другой, можно.' })).status, 201);
    console.log = quiet;
    console.log('PASS: повтор того же текста за сутки не пишется; не больше 3 в час и 10 в сутки, потом снова можно');

    if (!process.env.PLAYWRIGHT_MODULE) { console.log('SKIP: браузерная часть — нужен PLAYWRIGHT_MODULE'); return; }
    inbox = []; tg.length = 0;
    const browser = await require('./browser').launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/');
      await page.fill('#authEmail', user.email);
      await page.fill('#authPassword', 'right-password');
      await page.click('#authSubmit');
      await page.waitForSelector('#userBar', { state: 'visible' });
      await page.evaluate(() => goToCode('8517130000'));
      await page.waitForSelector('#resultSummary .vd-report');
      assert.equal(await page.textContent('#resultSummary .vd-report'), '⚑ Сообщить о неточности');
      await page.click('#resultSummary .vd-report');
      await page.waitForSelector('#activeModal #fbText');
      assert.equal(await page.textContent('#activeModal h2'), 'Сообщить о неточности');
      assert.match(await page.textContent('.fb-ctx'), /^8517 13 000 0 · ввоз · страна не выбрана · на \d{2}\.\d{2}\.\d{4}$/);
      const titles = await page.$$eval('#fbCard option', (o) => o.map((x) => x.textContent));
      assert.ok(titles.length > 4 && /Ко всему результату/.test(titles[0]), 'карточки результата в списке: ' + titles.length);
      // Короткий текст — сообщение, на сервер ничего не ушло.
      await page.fill('#fbText', 'мало');
      await page.click('#fbSend');
      assert.equal(await page.textContent('#fbError'), 'Опишите подробнее: не короче 10 знаков.');
      assert.equal(inbox.length, 0);
      // Счётчик знаков, выбор карточки, отправка.
      await page.fill('#fbText', 'Ставка по этому коду устарела — см. Решение № 112 от 2026.');
      assert.match(await page.textContent('#fbCount'), /^\d+ \/ 1500$/);
      await page.selectOption('#fbCard', '1');
      const picked = await page.$eval('#fbCard', (s) => s.options[s.selectedIndex].textContent);
      await page.click('#fbSend');
      await page.waitForSelector('#fbForm .auth-ok');
      assert.match(await page.textContent('#fbForm .auth-ok'), /Спасибо, сообщение отправлено/);
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].user_id, user.id);
      assert.match(inbox[0].subject, /^Неточность в базе: 8517 13 000 0 — /);
      assert.ok(inbox[0].subject.includes(picked.replace(/…$/, '').slice(0, 60)), 'в теме выбранная карточка: ' + inbox[0].subject + ' | ' + picked);
      assert.match(inbox[0].body_text, /Условия поиска: ввоз · страна не выбрана · на \d{4}-\d{2}-\d{2}$/);
      await page.click('#fbForm .calc-btn');
      await page.waitForSelector('#activeModal', { state: 'detached' });
      // Телефон: окно помещается, горизонтальной прокрутки нет.
      await page.setViewportSize({ width: 390, height: 800 });
      await page.click('#resultSummary .vd-report');
      await page.waitForSelector('#activeModal #fbText');
      const fit = await page.evaluate(() => { const b = document.querySelector('#activeModal .modal').getBoundingClientRect(); return { l: b.left, r: b.right, over: document.documentElement.scrollWidth > document.documentElement.clientWidth, w: window.innerWidth }; });
      assert.ok(fit.l >= 0 && fit.r <= fit.w + 0.5 && !fit.over, JSON.stringify(fit));
      // Выход закрывает окно: черновик следующему вошедшему не достаётся.
      await page.fill('#fbText', 'Черновик, который не должен достаться другому пользователю.');
      await page.evaluate(() => doLogout());
      await page.waitForSelector('#authScreen', { state: 'visible' });
      assert.equal(await page.$('#activeModal'), null);
      assert.deepEqual(errors, []);
      console.log('PASS: браузер — кнопка в шапке результата, окно с карточками на экране, отказ на короткий текст, отправка с выбранной карточкой, телефон 390 px, выход закрывает окно');
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
})().catch((err) => {
  console.log = quiet;
  console.error(err);
  process.exit(1);
});
