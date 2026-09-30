// node server/tests/watch.test.js
// «Мои коды» (services/watch.js, routes/watch.js, миграция 0018) на настоящей базе и src/index.js с
// подменённой таблицей: слепок кода не меняется от смены дня и меняется, когда мера со сроком
// вступает в силу; сравнение — появилось / изменилось / больше не действует; раз в сутки, одно письмо
// на пользователя, с 9:00 по Бишкеку, не тому, у кого истёк доступ; маршруты — только вошедшему с
// подтверждённым адресом, код из 10 цифр действующего ЕТТ, не больше 30. С PLAYWRIGHT_MODULE —
// браузер: кнопка «Следить» в шапке результата, окно «Мои коды», удаление, сброс при выходе.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const PORT = 42000 + Math.floor(Math.random() * 2000);
process.env.APP_ORIGIN = 'https://test.local,http://127.0.0.1:' + PORT;
process.env.SESSION_SECRET = 'local-check-only';
process.env.RESEND_API_KEY = 'test-key';
delete process.env.NODE_ENV;
delete process.env.TELEGRAM_BOT_TOKEN;

const hash = bcrypt.hashSync('right-password', 4);
const mk = (id, email, extra = {}) => ({ id, email, password_hash: hash, role: 'user', active: true, email_verified_at: new Date(),
  subscription_expires_at: '2099-01-01T23:59:59.999Z', last_seen_at: new Date(), ai_plan: 'base', terms_version: '2026-09-18', ...extra });
const user = mk('22222222-2222-4222-8222-222222222222', 'user@test.local');
const lapsed = mk('33333333-3333-4333-8333-333333333333', 'lapsed@test.local', { subscription_expires_at: '2026-01-01T23:59:59.999Z' });
const users = [user, lapsed];
let watched = []; // { user_id, code, snapshot, checked_on, changed_at, created_at }

require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, a = []) => {
  sql = sql.replace(/\s+/g, ' ').trim();
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: users.filter((u) => u.id === a[0] || u.email === a[0]).map((u) => ({ ...u })) };
  if (/^select code, created_at, changed_at from watched_codes where user_id = \$1/.test(sql)) return { rows: watched.filter((w) => w.user_id === a[0]) };
  if (/^select count\(\*\)::int as count from watched_codes/.test(sql)) return { rows: [{ count: watched.filter((w) => w.user_id === a[0]).length }] };
  if (/^select 1 as x from watched_codes/.test(sql)) return { rows: watched.filter((w) => w.user_id === a[0] && w.code === a[1]).map(() => ({ x: 1 })) };
  if (/^insert into watched_codes/.test(sql)) {
    if (!watched.some((w) => w.user_id === a[0] && w.code === a[1])) watched.push({ user_id: a[0], code: a[1], snapshot: JSON.parse(a[2]), checked_on: a[3], changed_at: null, created_at: new Date() });
    return { rows: [] };
  }
  if (/^delete from watched_codes/.test(sql)) { watched = watched.filter((w) => !(w.user_id === a[0] && w.code === a[1])); return { rows: [] }; }
  if (/^select w\.user_id, w\.code, w\.snapshot/.test(sql)) {
    return { rows: watched.filter((w) => !w.checked_on || w.checked_on < a[0]).map((w) => { const u = users.find((x) => x.id === w.user_id); return { ...w, email: u.email, role: u.role, active: u.active, email_verified_at: u.email_verified_at, subscription_expires_at: u.subscription_expires_at }; }) };
  }
  if (/^update watched_codes set snapshot/.test(sql)) {
    const w = watched.find((x) => x.user_id === a[0] && x.code === a[1]);
    w.snapshot = JSON.parse(a[2]); w.checked_on = a[3]; if (/changed_at = now\(\)/.test(sql)) w.changed_at = new Date();
    return { rows: [] };
  }
  return { rows: [] };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url) === 'https://api.resend.com/emails') { mails.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
  return realFetch(url, opts);
};
const quiet = console.log;

const watch = require('../src/services/watch');
const app = require('../src/index');
// Код стройматериалов по ПКМ № 614: карточка «разрешено» становится ограничением при ввозе.
const CODE = '6810119000';

(async () => {
  // Слепок: день в день не меняется, через месяц — меняется (мера со сроком).
  const d1 = watch.fingerprint(CODE, '2026-09-23'), d2 = watch.fingerprint(CODE, '2026-09-24'), m1 = watch.fingerprint(CODE, '2026-10-24');
  assert.deepEqual(d1, d2);
  const df = watch.diff(d1, m1);
  assert.equal(df.any, true);
  assert.equal(df.changed.length, 1, 'та же карточка, другой класс и метки');
  assert.equal(df.changed[0].before.c, 'c-ok');
  assert.equal(df.changed[0].after.c, 'c-im');
  assert.equal(watch.diff(d1, d2).any, false);
  // Появилось / больше не действует — на синтетике.
  const x = { c: 'c-ban', a: 'data-dir=im', n: 'Запрет X', t: ['⛔ Запрет'], r: '' };
  assert.deepEqual([watch.diff([], [x]).added.length, watch.diff([x], []).removed.length], [1, 1]);
  assert.equal(watch.isEttCode('8517130000'), true);
  assert.equal(watch.isEttCode('8517130001'), false);
  console.log('PASS: слепок не меняется от смены дня; мера со сроком — «изменилось»; появилось / больше не действует; код — только из ЕТТ');

  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + PORT;
  const hdr = { 'content-type': 'application/json', origin: 'https://test.local' };
  const login = async (email) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: hdr, body: JSON.stringify({ email, password: 'right-password' }) }));
  const call = (cookie, method, path, body) => fetch(base + path, { method, headers: { ...hdr, cookie }, body: body == null ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/api/watch')).status, 401);
    let r = await login(user.email);
    const uc = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await call(uc, 'POST', '/api/watch', { code: '6810' })).status, 400);
    assert.equal((await call(uc, 'POST', '/api/watch', { code: '8517130001' })).status, 404);
    r = await call(uc, 'POST', '/api/watch', { code: '6810 11 900 0' });
    assert.equal(r.status, 201);
    assert.match((await r.json()).name, /./);
    assert.equal((await (await call(uc, 'POST', '/api/watch', { code: CODE })).json()).already, true);
    const list = await (await call(uc, 'GET', '/api/watch')).json();
    assert.deepEqual([list.max, list.codes.map((c) => c.code)], [30, [CODE]]);
    // Потолок 30: заполняем кодами ЕТТ.
    const more = require('../src/services/base').load().ETT_DB.map((row) => row[0]).filter((c) => /^\d{10}$/.test(c) && c !== CODE).slice(0, 30);
    let last;
    for (const c of more) last = await call(uc, 'POST', '/api/watch', { code: c });
    assert.equal(last.status, 409);
    assert.equal(watched.filter((w) => w.user_id === user.id).length, 30);
    for (const c of more) await call(uc, 'DELETE', '/api/watch/' + c);
    assert.equal(watched.filter((w) => w.user_id === user.id).length, 1);
    console.log('PASS: маршруты — 401 без входа, 400/404 на кривой код, пробелы в коде допустимы, повтор — already, потолок 30 (409), удаление');

    // Задача: снимок сделан 24.09, 24.10 мера вступила — одно письмо; ночью и повторно — ничего;
    // истёкшему доступу письма нет, но снимок обновляется.
    watched.find((w) => w.code === CODE).snapshot = d1;
    watched.find((w) => w.code === CODE).checked_on = '2026-09-24';
    watched.push({ user_id: lapsed.id, code: CODE, snapshot: d1, checked_on: '2026-09-24', changed_at: null, created_at: new Date() });
    console.log = () => {};
    assert.deepEqual(await watch.run(new Date('2026-10-24T01:00:00Z')), { checked: 0, mailed: 0 }, 'до 9:00 по Бишкеку — не работает');
    const res = await watch.run(new Date('2026-10-24T06:00:00Z'));
    console.log = quiet;
    assert.deepEqual(res, { checked: 2, mailed: 1 });
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, user.email);
    assert.match(mails[0].subject, /^Изменения по вашим кодам ТН ВЭД \(1\)/);
    assert.match(mails[0].html, /6810 11 900 0/);
    assert.match(mails[0].html, /Изменилось:/);
    assert.ok(watched.every((w) => w.checked_on === '2026-10-24'));
    assert.ok(watched.find((w) => w.user_id === lapsed.id).changed_at, 'снимок истёкшего обновлён');
    console.log = () => {};
    assert.equal((await watch.run(new Date('2026-10-24T08:00:00Z'))).checked, 0, 'второй раз за день — ничего');
    console.log = quiet;
    console.log('PASS: задача — раз в сутки с 9:00, одно письмо на пользователя, «изменилось» по коду; истёкшему доступу — без письма');

    if (!process.env.PLAYWRIGHT_MODULE) { console.log('SKIP: браузерная часть — нужен PLAYWRIGHT_MODULE'); return; }
    const browser = await require(process.env.PLAYWRIGHT_MODULE).chromium.launch({ channel: 'msedge', headless: true });
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
      await page.waitForSelector('#resultSummary .vd-watch');
      await page.waitForFunction(() => document.querySelector('#resultSummary .vd-watch').getAttribute('aria-pressed') === 'false');
      await page.click('#resultSummary .vd-watch');
      await page.waitForFunction(() => document.querySelector('#resultSummary .vd-watch').getAttribute('aria-pressed') === 'true');
      assert.equal(await page.textContent('#resultSummary .vd-watch'), '★ Отслеживается');
      assert.ok(watched.some((w) => w.user_id === user.id && w.code === '8517130000'));
      // Окно «Мои коды» из меню: оба кода, удаление возвращает кнопку в «☆».
      await page.click('#accMenuBtn');
      await page.click('#accWatchBtn');
      await page.waitForSelector('.wl-row');
      assert.deepEqual(await page.$$eval('.wl-row', (rs) => rs.map((r) => r.dataset.code)), [CODE, '8517130000']);
      await page.click('.wl-row[data-code="8517130000"] .wl-del');
      await page.waitForFunction(() => document.querySelectorAll('.wl-row').length === 1);
      assert.equal(await page.getAttribute('#resultSummary .vd-watch', 'aria-pressed'), 'false');
      // Добавление из окна: кривой код — сообщение, верный — в списке.
      await page.fill('#wlCode', '1234');
      await page.click('#wlAdd');
      assert.equal(await page.textContent('#wlErr'), 'Нужен код из 10 цифр.');
      await page.fill('#wlCode', '8517 13 000 0');
      await page.click('#wlAdd');
      await page.waitForFunction(() => document.querySelectorAll('.wl-row').length === 2);
      // Открыть код из списка.
      await page.click('.wl-row[data-code="' + CODE + '"] .wl-open');
      await page.waitForFunction((c) => { const b = document.querySelector('#resultSummary .vd-watch'); return b && b.dataset.watch === c && b.getAttribute('aria-pressed') === 'true'; }, CODE);
      // Выход сбрасывает список в памяти страницы.
      await page.evaluate(() => doLogout());
      await page.waitForSelector('#authScreen', { state: 'visible' });
      assert.equal(await page.evaluate(() => watchSet), null);
      assert.deepEqual(errors, []);
      console.log('PASS: браузер — «Следить» в шапке результата, окно «Мои коды» (список, удалить, добавить, открыть), выход сбрасывает список');
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
