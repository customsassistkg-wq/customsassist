// node server/tests/terms-notice.test.js  (браузерная часть — с PLAYWRIGHT_MODULE)
// Уведомление об изменении правил на сайте (ч. 5 ст. 114 Цифрового кодекса; services/termsNotice.js): блок на экране входа и в
// приложении, пока не наступил день вступления; запись «показано» в журнале администрирования один раз на пользователя и дату;
// ссылка — только путь на нашем сайте, текст — текстом (не разметкой); после дня вступления и при пустой настройке блока нет.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const PORT = 27000 + Math.floor(Math.random() * 1000);
process.env.APP_ORIGIN = 'http://127.0.0.1:' + PORT;
process.env.SESSION_SECRET = 'local-check-only';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;
delete process.env.TURNSTILE_SECRET_KEY;
const NOTICE = { effective: '2099-01-01', url: '/terms-next.html', text: 'С 01.01.2099 вступает в силу новая редакция правил: тарифы, оплата и возврат.' };
process.env.TERMS_NOTICE = JSON.stringify(NOTICE);

const termsNotice = require('../src/services/termsNotice');

// ── служба ──
{
  const at = (iso) => Date.parse(iso);
  assert.deepEqual(termsNotice.current(at('2098-12-31T17:59:00Z')), NOTICE, 'накануне вечером по Бишкеку — показывается');
  assert.equal(termsNotice.current(at('2098-12-31T18:00:00Z')), null, 'в день вступления по Бишкеку (18:00 UTC накануне) — уже нет');
  assert.equal(termsNotice.current(at('2100-01-01T00:00:00Z')), null, 'после дня вступления — нет');
  for (const bad of [
    { ...NOTICE, url: '//evil.example/x' }, { ...NOTICE, url: 'https://evil.example/x' }, { ...NOTICE, url: '/\\evil.example' },
    { ...NOTICE, url: 'terms-next.html' }, { ...NOTICE, url: 1 }, { ...NOTICE, text: '' }, { ...NOTICE, text: '   ' }, { ...NOTICE, text: 5 },
    { ...NOTICE, effective: '2099-1-1' }, { ...NOTICE, effective: undefined }, [], 'строка', 7,
  ]) {
    process.env.TERMS_NOTICE = JSON.stringify(bad);
    assert.equal(termsNotice.current(at('2026-10-01T00:00:00Z')), null, 'неверная настройка не показывается: ' + JSON.stringify(bad));
  }
  process.env.TERMS_NOTICE = '{не json';
  assert.equal(termsNotice.current(at('2026-10-01T00:00:00Z')), null, 'испорченная настройка — блока нет, ошибки нет');
  process.env.TERMS_NOTICE = '';
  assert.equal(termsNotice.current(at('2026-10-01T00:00:00Z')), null, 'пустая TERMS_NOTICE выключает уведомление');
  process.env.TERMS_NOTICE = JSON.stringify({ ...NOTICE, text: 'я'.repeat(500) });
  assert.equal(termsNotice.current(at('2026-10-01T00:00:00Z')).text.length, 300, 'текст не длиннее 300 знаков');
  process.env.TERMS_NOTICE = JSON.stringify(NOTICE);
  delete process.env.TERMS_NOTICE;
  assert.equal(termsNotice.current(at('2026-10-01T00:00:00Z')), null, 'встроенного уведомления нет: редакция от 01.10.2026 вступила в силу 03.11.2026');
  process.env.TERMS_NOTICE = JSON.stringify(NOTICE);
  console.log('PASS: служба — показывается до дня вступления по Бишкеку, неверная и пустая настройка не показываются, ссылка только путь на нашем сайте');
}

// ── маршруты ──
const user = { id: '22222222-2222-4222-8222-222222222222', email: 'user@test.local', password_hash: bcrypt.hashSync('user-password', 4), role: 'user', active: true,
  email_verified_at: new Date(), subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: require('./terms-version'), totp_secret: null, totp_enabled_at: null };
const audit = [];
let inserts = 0;
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, a = []) => {
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: [user].filter((u) => u.id === a[0] || u.email === a[0]) };
  if (/insert into admin_audit_log[\s\S]*'terms_notice'/.test(sql)) {
    inserts++;
    const d = JSON.parse(a[1]);
    if (!audit.some((r) => r.target === a[0] && r.detail.effective === a[2] && r.detail.via === 'banner')) audit.push({ target: a[0], detail: d });
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };
const app = require('../src/index');

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = 'http://127.0.0.1:' + PORT;
  let browser;
  try {
    const login = (ip) => fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': ip },
      body: JSON.stringify({ email: user.email, password: 'user-password' }) });
    const cfg = await (await fetch(origin + '/api/auth/config')).json();
    assert.deepEqual(cfg.termsNotice, NOTICE, 'гостю — в /api/auth/config');
    const l1 = await login('10.2.0.1');
    assert.equal(l1.status, 200);
    const body1 = await l1.json();
    assert.deepEqual(body1.termsNotice, NOTICE, 'вошедшему — в ответе входа');
    const cookie = (l1.headers.get('set-cookie') || '').split(';')[0];
    assert.equal(inserts, 1, 'вход записал «показано»');
    assert.equal(audit[0].detail.via, 'banner'); assert.equal(audit[0].detail.email, user.email); assert.equal(audit[0].detail.effective, '2099-01-01');
    const me1 = await (await fetch(origin + '/api/auth/me', { headers: { cookie } })).json();
    assert.deepEqual(me1.termsNotice, NOTICE, '/api/auth/me несёт уведомление');
    await fetch(origin + '/api/auth/me', { headers: { cookie } });
    assert.equal(inserts, 1, 'в одном сеансе запись не повторяется');
    await login('10.2.0.2');
    assert.equal(inserts, 2, 'новый сеанс пробует записать ещё раз…');
    assert.equal(audit.length, 1, '…но запись одна на пользователя и дату (insert … where not exists)');
    // после дня вступления и при пустой настройке — ни блока, ни записи
    process.env.TERMS_NOTICE = JSON.stringify({ ...NOTICE, effective: '2020-01-01' });
    assert.equal((await (await fetch(origin + '/api/auth/config')).json()).termsNotice, null);
    const l3 = await login('10.2.0.3');
    assert.equal((await l3.json()).termsNotice, null);
    process.env.TERMS_NOTICE = '';
    assert.equal((await (await fetch(origin + '/api/auth/me', { headers: { cookie } })).json()).termsNotice, null);
    assert.equal(inserts, 2, 'без уведомления журнал не пишется');
    process.env.TERMS_NOTICE = JSON.stringify(NOTICE);
    console.log('PASS: маршруты — гость получает уведомление в config, вошедший в ответе входа и /me; запись «показано» раз в сеанс и раз на пользователя; после дня вступления и при выключении — нет');

    // ── браузер ──
    if (!process.env.PLAYWRIGHT_MODULE) { console.log('SKIP: браузерная часть — нужен PLAYWRIGHT_MODULE'); return; }
    browser = await require('./browser').launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/');
    await page.locator('#authEmail').waitFor({ state: 'visible' });
    const gn = page.locator('#authNotice');
    await gn.waitFor({ state: 'visible' });
    assert.match(await gn.innerText(), /С 01\.01\.2099 вступает в силу новая редакция правил/);
    const link = gn.locator('a');
    assert.equal(await link.getAttribute('href'), '/terms-next.html');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match(await link.getAttribute('rel'), /noopener/);
    await page.locator('#authRegisterLink').click();
    await page.locator('#authViewRegister').waitFor({ state: 'visible' });
    assert.equal(await gn.isVisible(), true, 'на экране регистрации уведомление тоже видно');
    await page.locator('#authRegisterBackLink').click();
    await page.locator('#authEmail').fill(user.email);
    await page.locator('#authPassword').fill('user-password');
    await page.locator('#authSubmit').click();
    await page.locator('#appWrap').waitFor({ state: 'visible' });
    const an = page.locator('#appNotice');
    await an.waitFor({ state: 'visible' });
    assert.match(await an.innerText(), /С 01\.01\.2099 вступает в силу/);
    assert.equal(await an.locator('a').getAttribute('href'), '/terms-next.html');
    assert.equal(await page.locator('#authNotice').isVisible(), false, 'экран входа за приложением скрыт');
    await an.locator('.tn-close').click();
    assert.equal(await an.isVisible(), false, 'крестик закрывает блок до следующего входа');
    const stored = await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)));
    assert.ok(!stored.some((k) => /notice|terms/i.test(k)), 'закрытие блока ничего не пишет в хранилище: ' + stored.join(','));
    // выход: блок приложения стёрт (resetAppView), экран входа снова показывает своё
    await page.evaluate(() => doLogout());
    await page.locator('#authEmail').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.getElementById('appNotice').textContent), '', 'выход стирает блок приложения');
    await gn.waitFor({ state: 'visible' });
    await page.locator('#authEmail').fill(user.email);
    await page.locator('#authPassword').fill('user-password');
    await page.locator('#authSubmit').click();
    await an.waitFor({ state: 'visible' });
    // текст — текстом, не разметкой
    await page.close();
    process.env.TERMS_NOTICE = JSON.stringify({ ...NOTICE, text: '<img src=x onerror="window.__xss=1"> <b>важно</b>' });
    const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); // без сеанса: гостевой экран
    const p2 = await guestCtx.newPage();
    await p2.goto(origin + '/');
    await p2.locator('#authNotice').waitFor({ state: 'visible' });
    assert.equal(await p2.locator('#authNotice img, #authNotice b').count(), 0, 'разметка в тексте не становится элементами');
    assert.match(await p2.locator('#authNotice').innerText(), /<img src=x onerror="window.__xss=1"> <b>важно<\/b>/);
    assert.equal(await p2.evaluate(() => window.__xss), undefined);
    await p2.close();
    // страница не доверяет ответу сервера: ссылка не на наш путь — блок скрыт
    process.env.TERMS_NOTICE = JSON.stringify(NOTICE);
    const p3 = await guestCtx.newPage();
    await p3.route('**/api/auth/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ turnstileSiteKey: null, termsNotice: { ...NOTICE, url: '//evil.example/x' } }) }));
    await p3.goto(origin + '/');
    await p3.locator('#authEmail').waitFor({ state: 'visible' });
    await p3.waitForTimeout(400);
    assert.equal(await p3.locator('#authNotice').isVisible(), false, 'ссылка вида //host отвергнута страницей');
    await p3.close();
    await guestCtx.close();
    // вошедший пользователь с уже открытой сессией: экран входа не мигает уведомлением, приложение показывает своё
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const cookie2 = (await login('10.2.0.9')).headers.get('set-cookie').split(';')[0];
    await ctx2.addCookies([{ name: cookie2.slice(0, cookie2.indexOf('=')), value: decodeURIComponent(cookie2.slice(cookie2.indexOf('=') + 1)), url: origin }]);
    const p4 = await ctx2.newPage();
    let guestConfigAsked = false;
    p4.on('request', (r) => { if (r.url().endsWith('/api/auth/config')) guestConfigAsked = true; });
    await p4.goto(origin + '/');
    await p4.locator('#appNotice').waitFor({ state: 'visible' });
    assert.equal(guestConfigAsked, false, 'вошедший не запрашивает гостевые настройки');
    assert.equal(await p4.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'на 390 px нет горизонтальной прокрутки');
    await ctx2.close();
    assert.deepEqual(errors, []);
    console.log('PASS: браузер — блок на экране входа и регистрации, в приложении (с крестиком, без записи в хранилище), стирается выходом; текст не становится разметкой; чужая ссылка отвергнута; вошедший не запрашивает гостевые настройки');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
