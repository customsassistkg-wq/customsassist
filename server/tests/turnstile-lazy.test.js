// node server/tests/turnstile-lazy.test.js  (нужен PLAYWRIGHT_MODULE; без него — SKIP)
// Скрипт капчи Cloudflare (85 КБ и обращение к чужому серверу) грузится, когда гостю показана форма входа, регистрации или
// восстановления пароля, — а не на каждом открытии страницы (до 01.10.2026 грузился всегда, и вошедший пользователь тоже
// отправлял IP и сведения о браузере в Cloudflare при каждом открытии приложения и тратил трафик на экране, где капчи нет).
// На настоящем src/index.js с подменённой базой; Cloudflare подменён заглушкой, которая записывает вызовы render.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

if (!process.env.PLAYWRIGHT_MODULE) {
  console.log('SKIP: нужен PLAYWRIGHT_MODULE (браузер)');
  process.exit(0);
}
const PORT = 25000 + Math.floor(Math.random() * 1000);
process.env.APP_ORIGIN = 'http://127.0.0.1:' + PORT;
process.env.SESSION_SECRET = 'local-check-only';
process.env.TURNSTILE_SITE_KEY = 'test-site-key';
process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;

const user = { id: '22222222-2222-4222-8222-222222222222', email: 'user@test.local', password_hash: bcrypt.hashSync('user-password', 4), role: 'user', active: true,
  email_verified_at: new Date(), subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: require('./terms-version'), totp_secret: null, totp_enabled_at: null };
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, a = []) => {
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: [user].filter((u) => u.id === a[0] || u.email === a[0]) };
  return { rows: [], rowCount: 0 };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };
const app = require('../src/index');

// Заглушка скрипта Cloudflare: после загрузки зовёт onTurnstileLoad и записывает, какие виджеты просили нарисовать.
const STUB = `window.__tsRenders=[];window.turnstile={render:function(box,o){window.__tsRenders.push(o.action);return 'w'+window.__tsRenders.length},getResponse:function(){return 'token'},reset:function(){}};
setTimeout(function(){if(window.onTurnstileLoad)window.onTurnstileLoad()},0);`;

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = 'http://127.0.0.1:' + PORT;
  const browser = await require('./browser').launch();
  try {
    const watch = async (ctx) => {
      const seen = { script: 0 };
      await ctx.route('https://challenges.cloudflare.com/**', (route) => {
        seen.script++;
        route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB });
      });
      return seen;
    };

    // 1. Гость: форма входа показана — скрипт загружен один раз; регистрация и восстановление рисуют свои виджеты.
    const g = await browser.newContext();
    const gSeen = await watch(g);
    const guest = await g.newPage();
    const errors = [];
    guest.on('pageerror', (e) => errors.push(e.message));
    await guest.goto(origin + '/');
    await guest.locator('#authEmail').waitFor({ state: 'visible' });
    await guest.waitForFunction(() => Array.isArray(window.__tsRenders));
    assert.equal(gSeen.script, 1, 'гость: скрипт капчи загружен один раз');
    await guest.locator('#authRegisterLink').click();
    await guest.waitForFunction(() => window.__tsRenders.includes('register'));
    await guest.locator('#authRegisterBackLink').click();
    await guest.locator('#authForgotLink').click();
    await guest.waitForFunction(() => window.__tsRenders.includes('forgot-password'));
    assert.equal(gSeen.script, 1, 'гость: повторных загрузок скрипта нет');
    assert.deepEqual(errors, []);
    await g.close();
    console.log('PASS: гость — скрипт капчи загружен один раз, при показе регистрации и восстановления виджеты нарисованы');

    // 2. Вошедший пользователь: приложение открывается без обращения к Cloudflare; после выхода (снова гость) скрипт загружается.
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: user.email, password: 'user-password' }) });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const [name, value] = [cookie.slice(0, cookie.indexOf('=')), decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))];
    const c = await browser.newContext();
    await c.addCookies([{ name, value, url: origin }]);
    const cSeen = await watch(c);
    const page = await c.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(origin + '/');
    await page.locator('#appWrap').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    assert.equal(cSeen.script, 0, 'вошедший пользователь: к Cloudflare никто не обращался');
    await page.evaluate(() => doLogout());
    await page.locator('#authEmail').waitFor({ state: 'visible' });
    await page.waitForFunction(() => Array.isArray(window.__tsRenders));
    assert.equal(cSeen.script, 1, 'после выхода — гость: скрипт загружен');
    assert.deepEqual(pageErrors, []);
    await c.close();
    console.log('PASS: вошедший пользователь — страница и приложение без обращения к Cloudflare; после выхода форма входа загружает скрипт');

    // 3. Ссылка сброса пароля (?reset=…): формы с капчей нет — скрипт не нужен; вернувшись ко входу, гость его получает.
    const r = await browser.newContext();
    const rSeen = await watch(r);
    const reset = await r.newPage();
    await reset.goto(origin + '/?reset=some-token');
    await reset.locator('#authViewReset').waitFor({ state: 'visible' });
    await reset.waitForTimeout(500);
    assert.equal(rSeen.script, 0, 'вид сброса пароля: капчи нет, скрипт не грузится');
    await r.close();
    console.log('PASS: вид сброса пароля не загружает капчу');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
