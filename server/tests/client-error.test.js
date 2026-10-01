// node server/tests/client-error.test.js  (браузерная часть — с PLAYWRIGHT_MODULE)
// Ошибки браузера (/api/client-error) и проверка для монитора доступности (/api/health) на настоящем
// src/index.js: Origin, очистка текста (коды из поиска, почта, параметры адреса, blob: → checker.js),
// шум и чужие скрипты, лимит с адреса, одно сообщение в Telegram на ошибку в сутки; /api/health —
// да/нет по базе ТН ВЭД и PostgreSQL, без сессии. Браузер: обработчик страницы ловит ошибку и отказ
// промиса гостя, шум и шестую ошибку не шлёт; подвал берёт логотип файлом. База и сессии подменены, сети нет.
const assert = require('node:assert/strict');
const net = require('node:net');

(async () => {
  // Порт заранее: странице в браузере нужен свой origin в APP_ORIGIN, а он читается при загрузке index.js.
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  process.env.APP_ORIGIN = `https://test.local,${base}`;
  process.env.SESSION_SECRET = 'local-check-only';
  delete process.env.NODE_ENV;
  let dbDown = false;
  require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async () => {
    if (dbDown) throw new Error('connection refused');
    return { rows: [] };
  } } } };
  require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };
  const telegram = require('../src/services/telegram');
  const notes = [];
  telegram.notify = (html) => notes.push(html);
  // До загрузки приложения: metrics.js оборачивает console.warn, который застанет.
  const warns = [];
  console.warn = (...args) => warns.push(args.join(' '));
  const ce = require('../src/routes/clientError');
  const app = require('../src/index');

  // ── Очистка текста и браузер ──
  assert.equal(ce.clean("Cannot read properties of undefined (reading '8517 13 000 0')", 300), "Cannot read properties of undefined (reading '#')");
  assert.equal(ce.clean('at render (blob:https://customsassist.trade/0a1b2c3d-1111-2222-3333-444455556666:1234:56)', 300), 'at render (checker.js:1234:56)');
  assert.equal(ce.clean('at x (https://customsassist.trade/?reset=abcdef123456:1:5)', 300), 'at x (/:1:5)');
  assert.equal(ce.clean('нет адреса user.name+tag@mail.kg в 2026 году, код 8517130000', 300), 'нет адреса <email> в # году, код #');
  assert.equal(ce.clean('a\nb\r\n  c\u0007d', 300), 'a | b | c d');
  assert.equal(ce.clean('x'.repeat(500), 300).length, 300);
  const ua = {
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  };
  assert.equal(ce.browserOf(ua.android), 'Chrome 129 Android');
  assert.equal(ce.browserOf(ua.iphone), 'Safari 18 iPhone');
  assert.equal(ce.browserOf(ua.edge), 'Edge 129 Windows');
  assert.equal(ce.browserOf(''), 'браузер ?');
  // враждебный текст не занимает процесс: сначала обрезка, потом выражения (100 КБ «aaaa…» стоили 30 с, 01.10.2026)
  const t0 = Date.now();
  ce.clean('a'.repeat(100000), 1500); ce.clean('blob:'.repeat(20000), 1500); ce.clean('.+'.repeat(50000), 1500);
  assert.ok(Date.now() - t0 < 1000, `очистка враждебного текста — ${Date.now() - t0} мс`);
  console.log('PASS: очистка — коды и годы в #, почта, параметры адреса, blob: → checker.js с номером строки; браузер по приоритету');

  const server = app.listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const report = (body, headers = {}) => fetch(base + '/api/client-error', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://test.local', 'user-agent': ua.android, ...headers }, body: JSON.stringify(body) });
  const logged = () => warns.filter((w) => w.startsWith('client-error:'));
  let browser;
  try {
    // ── Маршрут ──
    let r = await fetch(base + '/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403, 'без Origin — отказ, как у любого запроса, меняющего данные');
    r = await report({ k: 'error', m: "TypeError: Cannot read properties of null (reading '8517130000')", s: 'blob:https://customsassist.trade/0a1b2c3d-1111-2222-3333-444455556666',
      l: 812, c: 17, st: 'TypeError: x\n    at render (blob:https://customsassist.trade/0a1b2c3d-1111-2222-3333-444455556666:812:17)', p: 'navCalcBtn' }, { 'x-forwarded-for': '10.0.0.1' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('set-cookie'), null, 'гостю сессия не заводится');
    assert.equal(logged().length, 1);
    assert.equal(logged()[0], "client-error: guest [navCalcBtn] error TypeError: Cannot read properties of null (reading '#') @ checker.js:812:17 (Chrome 129 Android)"
      + ' | TypeError: x | at render (checker.js:812:17)');
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Ошибка в браузере[\s\S]*checker\.js:812:17 · раздел navCalcBtn · без входа · Chrome 129 Android/);
    assert.ok(!/8517130000/.test(notes[0] + logged()[0]), 'код из поиска не уходит ни в журнал, ни в Telegram');
    // та же ошибка ещё раз — строка в журнале, но не второе сообщение
    await report({ m: "TypeError: Cannot read properties of null (reading '8517130000')", s: 'blob:x-0a1b2c3d-1111-2222-3333-444455556666', l: 812, c: 17 }, { 'x-forwarded-for': '10.0.0.1' });
    assert.equal(logged().length, 2);
    assert.equal(notes.length, 1, 'об одной ошибке — одно сообщение в сутки');
    // шум и чужие скрипты не пишутся; кривое тело — тоже 204 и молча
    for (const body of [{ m: 'TypeError: Failed to fetch' }, { m: 'Script error.' }, { m: 'ResizeObserver loop limit exceeded' }, { m: 'AbortError: The user aborted a request.' },
      { m: 'x is not defined', s: 'chrome-extension://abcdef/content.js' }, { m: '' }, { m: { toString: 1 } }]) {
      assert.equal((await report(body, { 'x-forwarded-for': '10.0.0.2' })).status, 204);
    }
    r = await fetch(base + '/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://test.local' }, body: '[1,2' });
    assert.equal(r.status, 400, 'битый JSON — 400 из общего разбора тела');
    assert.equal(logged().length, 2, 'шум, чужой скрипт, пустой текст и объект вместо текста не записаны');
    // тело больше 8 КБ — не отчёт страницы: 204 и ни строки
    assert.equal((await report({ m: 'Error: big ' + 'x'.repeat(9000) }, { 'x-forwarded-for': '10.0.0.4' })).status, 204);
    assert.equal(logged().length, 2, 'тело больше 8 КБ не разбирается');
    // лимит: 20 отчётов в час с адреса, остальные молча
    for (let i = 0; i < 25; i++) await report({ m: `Error: flood ${'abc'[i % 3]}${i}` }, { 'x-forwarded-for': '10.0.0.3' });
    assert.equal(logged().filter((w) => /flood/.test(w)).length, 20);
    // сообщений в Telegram — не больше 10 в сутки, сколько бы разных ошибок ни было
    assert.ok(notes.length <= ce.LIMITS.notifyPerDay, `сообщений ${notes.length}`);
    assert.equal(notes.length, ce.LIMITS.notifyPerDay);
    console.log('PASS: /api/client-error — 403 без Origin, 204 всегда, строка журнала без кода, шум и расширения молча, 20 в час с адреса, Telegram — раз на ошибку и не больше 10 в сутки');

    // ── /api/health ──
    r = await fetch(base + '/api/health');
    assert.deepEqual([r.status, await r.json()], [503, { ok: false }], 'база ТН ВЭД ещё не разобрана');
    require('../src/services/base').load();
    r = await fetch(base + '/api/health');
    assert.deepEqual([r.status, await r.json(), r.headers.get('cache-control'), r.headers.get('set-cookie')], [200, { ok: true }, 'no-store', null]);
    dbDown = true;
    r = await fetch(base + '/api/health');
    assert.deepEqual([r.status, await r.json()], [503, { ok: false }], 'PostgreSQL не отвечает');
    dbDown = false;
    console.log('PASS: /api/health — 200 только с базой ТН ВЭД и PostgreSQL, иначе 503; без сессии и кэша');

    // ── Браузер: обработчик страницы ──
    if (!process.env.PLAYWRIGHT_MODULE) {
      console.log('SKIP: браузерная часть — нужен PLAYWRIGHT_MODULE');
      return;
    }
    browser = await require('./browser').launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Ссылка сброса пароля: токен в адресе есть, пока страница его не убрала, — в отчёт он попасть не должен.
    await page.goto(base + '/?reset=secret-token-123456');
    await page.waitForFunction(() => { const a = document.getElementById('authScreen'); return a && getComputedStyle(a).display !== 'none'; });
    await page.waitForLoadState('networkidle');
    const before = logged().length;
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('boom в коде 8517130000 у user@mail.kg'); });
      Promise.reject(new Error('отказ промиса 0201100001'));
      Promise.reject(new TypeError('Failed to fetch'));
    });
    const deadline = Date.now() + 5000;
    while (logged().length < before + 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const got = logged().slice(before);
    assert.equal(got.length, 2, 'ошибка и отказ промиса — да, «Failed to fetch» — нет');
    assert.ok(got.some((w) => /guest \[auth\] error .*boom в коде # у <email>/.test(w)), got.join('\n'));
    assert.ok(got.some((w) => /guest \[auth\] rejection отказ промиса #/.test(w)), got.join('\n'));
    assert.ok(!got.join('\n').match(/8517130000|0201100001|user@mail|secret-token/), 'ни кода, ни почты, ни токена из адреса');
    // не больше пяти отчётов за загрузку страницы
    await page.evaluate(() => { for (let i = 0; i < 8; i++) setTimeout(() => { throw new Error('err ' + 'abcdefgh'[i]); }); });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(logged().length - before, 5, 'пять за загрузку');
    // подвал: логотип — файл 120×120, а не base64 в странице
    const logo = await page.evaluate(async () => {
      const img = document.querySelector('.app-footer img');
      img.loading = 'eager';
      if (!img.complete || !img.naturalWidth) await new Promise((r) => { img.onload = r; img.onerror = r; });
      return [img.getAttribute('src'), img.naturalWidth, img.naturalHeight];
    });
    assert.deepEqual(logo, ['/assets/footer-logo.webp', 120, 120]);
    assert.deepEqual(errors.filter((e) => !/boom|отказ промиса|Failed to fetch|^err [a-h]$/.test(e)), [], 'других ошибок на странице нет');
    console.log('PASS: браузер — ошибка и отказ промиса гостя доходят очищенными, шум и шестая — нет; логотип подвала — файл 120×120');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
