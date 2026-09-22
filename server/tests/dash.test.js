// node server/tests/dash.test.js
// Дашборд администраторов на настоящем src/index.js: /api/dash.js и /api/dash/data — только
// администратору; вход на имени дашборда (DASH_ORIGIN) закрыт не администраторам и не
// выбивает сессию основного сайта; страница server/dash/index.html держит только вход.
// База и хранилище сессий подменены, сети нет. Браузерная часть — при PLAYWRIGHT_MODULE:
// вход администратора, семь разделов, обе темы, 1280 и 420 px без горизонтальной прокрутки,
// не администратору — отказ на экране входа.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');

process.env.APP_ORIGIN = 'https://test.local';
process.env.DASH_ORIGIN = 'https://dash.test.local';
process.env.SESSION_SECRET = 'local-check-only';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;

const hash = bcrypt.hashSync('right-password', 4);
const admin = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@test.local', password_hash: hash, role: 'admin',
  active: true, email_verified_at: new Date(), subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: '2026-09-18' };
const user = { id: '22222222-2222-4222-8222-222222222222', email: 'user@test.local', password_hash: hash, role: 'user',
  active: true, email_verified_at: new Date(), subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: '2026-09-18' };
const users = [admin, user];
const sessionUpdates = []; // [sql, args] каждого endUserSessions
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => {
  if (/^update session/.test(sql)) { sessionUpdates.push([sql, args]); return { rows: [] }; }
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: users.filter((u) => u.id === args[0] || u.email === args[0]) };
  if (/select version\(\)/.test(sql)) return { rows: [{ v: 'PostgreSQL 16.3 on x86_64' }] };
  if (/count\(\*\)::int as total/.test(sql)) return { rows: [{ total: 2, active: 2, admins: 1, online: 1, terms_current: 2, plan_base: 2, plan_pro: 0, plan_max: 0 }] };
  if (/from admin_audit_log a/.test(sql)) return { rows: [{ created_at: new Date(), actor: admin.email, action: 'set_role', target: user.email, detail: { role: 'user' } }] };
  return { rows: [] };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };
// База — маленькая подделка: раздел «Правовая база» считает сроки, а не разбирает 12 МБ.
require.cache[require.resolve('../src/services/base')] = { exports: {
  load: () => ({ ENGINE_API: {}, ETT_DB: [['0101210000', 'Лошади', 'шт', 0]], TNVED_MAP: { a: 1 },
    BAN_DB: [{ exUntil: '2027-03-11', codes: ['0101'], name: 'Лошади', ex: true, im: false }, { imUntil: '2026-10-25', codes: ['6809'], name: 'Гипсокартон', im: true, ex: false, unver: true }],
    ANTIDUMP_DB: [[['2933610000'], 'КНР', 'Меламин', '15%', 'Решение', null, '2027-05-08']],
    LK_IN_FORCE: { 'ОАЭ': '2026-10-06' }, SOURCE_AUDIT: { ban: { n: 'Запреты', st: 'ok', d: '21.09.2026', u: 'https://cbd.minjust.gov.kg/' }, tr: { n: 'ТР', st: 'part', d: '19.09.2026' } },
    AUDIT_REV: 'test', UNIMEAS_ASOF: '16.09.2026' }),
  has: () => false, call: () => null, info: { loadedAt: new Date().toISOString(), loadMs: 1 },
} };

const root = path.join(__dirname, '../..');
const dashCode = fs.readFileSync(path.join(root, 'server/private/dash.js'), 'utf8');
const pageHtml = fs.readFileSync(path.join(root, 'server/dash/index.html'), 'utf8');

(async () => {
  // Список разрешённых Origin собирается при загрузке index.js, поэтому адрес браузерной
  // части (свободный порт) известен заранее и вписан в APP_ORIGIN до require.
  const frontPort = await new Promise((r) => { const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  process.env.APP_ORIGIN = 'https://test.local,http://127.0.0.1:' + frontPort;
  const app = require('../src/index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  // Хост дашборда: Nginx передаёт Host; при trust proxy Express читает X-Forwarded-Host.
  const dashHdr = { origin: 'https://dash.test.local', 'x-forwarded-host': 'dash.test.local' };
  const siteHdr = { origin: 'https://test.local', 'x-forwarded-host': 'test.local' };
  const login = (email, headers) => fetch(base + '/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email, password: 'right-password' }) });
  const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];
  let browser, fserver;
  try {
    // Без сессии: код и данные закрыты.
    assert.equal((await fetch(base + '/api/dash.js')).status, 401);
    assert.equal((await fetch(base + '/api/dash/data')).status, 403);

    // Не администратор на имени дашборда — отказ после пароля, без cookie.
    let r = await login(user.email, dashHdr);
    assert.deepEqual([r.status, (await r.json()).error, r.headers.get('set-cookie')], [403, 'admin_only', null]);

    // Администратор на имени дашборда — вход; замена сессий только в кругу дашборда.
    sessionUpdates.length = 0;
    r = await login(admin.email, dashHdr);
    assert.equal(r.status, 200);
    const dashCookie = cookieOf(r);
    assert.equal(sessionUpdates.length, 1);
    assert.match(sessionUpdates[0][0], /coalesce\(sess ->> 'dash', 'false'\) = \$3/);
    assert.deepEqual(sessionUpdates[0][1], [admin.id, 'replaced', 'true']);

    r = await fetch(base + '/api/dash.js', { headers: { cookie: dashCookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /private, no-cache, must-revalidate/);
    assert.equal(await r.text(), dashCode);

    r = await fetch(base + '/api/dash/data', { headers: { cookie: dashCookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /no-store/);
    const d = await r.json();
    for (const k of ['now', 'system', 'db', 'certs', 'services', 'base', 'http', 'users', 'engine', 'assistant', 'audit']) assert.ok(k in d, 'нет раздела ' + k);
    assert.equal(d.viewer, admin.email);
    assert.equal(typeof d.system.node, 'string');
    assert.equal(d.db.version, 'PostgreSQL 16.3');
    assert.equal(d.services.origins.dash, 'https://dash.test.local');
    assert.equal(d.users.overview.total, 2);
    assert.equal(d.audit.length, 1);
    assert.ok(d.http.total >= 4 && d.http.minutes.length === 60 && d.http.routes.some((x) => x.key === 'POST /api/auth/login'),
      'счётчики запросов: ' + JSON.stringify({ total: d.http.total, minutes: d.http.minutes.length, routes: d.http.routes.map((x) => x.key) }));
    // Правовая база: два запрета (один «не подтверждено»), антидемпинг, соглашение; сверка 1 ✔ 1 ◐.
    assert.deepEqual(d.base.dated.map((m) => [m.kind, m.until || m.from, m.unver]),
      [['Запрет', '2027-03-11', false], ['Запрет', '2026-10-25', true], ['Антидемпинг', '2027-05-08', false], ['Соглашение', '2026-10-06', false]]);
    assert.deepEqual(d.base.audit.counts, { ok: 1, part: 1, old: 0 });
    assert.equal(d.base.audit.last, '2026-09-21');
    assert.equal(d.base.ett, 1);
    // Экономика: тарифы из кода; пустые таблицы оплат и расходов раздел не ломают
    assert.deepEqual([d.economy.plans.max.price, d.economy.plans.base.pages], [1990, 30]);
    assert.deepEqual(d.economy.subscriptions, { paid: 0, unlimited: 0, expired: 0, mrrKgs: 0 });
    assert.deepEqual([d.economy.api.visionUsd, d.economy.api.modelUsd, d.economy.payments.recent], [0, 0, []]);

    // Обычный пользователь на основном сайте входит, но дашборд ему закрыт.
    sessionUpdates.length = 0;
    r = await login(user.email, siteHdr);
    assert.equal(r.status, 200);
    assert.deepEqual(sessionUpdates[0][1], [user.id, 'replaced', 'false'], 'вход на сайте не трогает сессии дашборда');
    const userCookie = cookieOf(r);
    assert.equal((await fetch(base + '/api/dash.js', { headers: { cookie: userCookie } })).status, 403);
    assert.equal((await fetch(base + '/api/dash/data', { headers: { cookie: userCookie } })).status, 403);

    // Чужой origin по-прежнему закрыт, www дашборда — тоже.
    r = await login(admin.email, { origin: 'https://www.dash.test.local' });
    assert.equal(r.status, 403);

    // Страница держит только вход: без кода разделов и без цифр.
    r = await fetch(base + '/dash');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.equal(html, pageHtml);
    assert.ok(html.includes('id="authScreen"') && html.includes('/api/dash.js'));
    for (const name of ['secHealth', 'secUsers', 'bindTips', 'function columns']) assert.ok(!html.includes(name), name + ' не должен быть в странице');
    // Всё, что доступно до входа, обходится кодом самой страницы (AUTH_EMAIL_RE, не EMAIL_RE).
    assert.ok(html.includes('AUTH_EMAIL_RE') && !/[^_]EMAIL_RE\b/.test(html.replace(/AUTH_EMAIL_RE/g, '')));

    if (process.env.PLAYWRIGHT_MODULE) {
      // Страница отдаётся с политикой CSP блока dash.* из nginx.conf: скрипт-blob и Turnstile разрешены, остальное — нет.
      const nginx = fs.readFileSync(path.join(__dirname, '../nginx.conf'), 'utf8');
      const dashBlock = nginx.slice(nginx.indexOf('server_name dash.customsassist.trade'));
      const csp = dashBlock.match(/add_header Content-Security-Policy "([^"]+)"/)[1];
      const express = require('express');
      const front = express();
      front.get('/', (req, res) => res.set('Content-Security-Policy', csp).type('html').send(pageHtml));
      front.use('/assets', express.static(path.join(root, 'assets')));
      front.use(app);
      fserver = front.listen(frontPort, '127.0.0.1');
      await new Promise((r) => fserver.once('listening', r));
      const origin = 'http://127.0.0.1:' + frontPort;
      process.env.DASH_ORIGIN = origin; // браузер шлёт Host этого адреса: вход здесь — вход на дашборд
      browser = await require(process.env.PLAYWRIGHT_MODULE).chromium.launch({ channel: 'msedge', headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [], csps = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.exposeFunction('__csp', (v) => csps.push(v));
      await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__csp(e.violatedDirective + ' ' + e.blockedURI)));
      await page.goto(origin);
      await page.locator('#authViewLogin').waitFor({ state: 'visible', timeout: 10000 });
      // Не администратор: отказ на экране входа, дашборд не открывается.
      await page.fill('#authEmail', user.email);
      await page.fill('#authPassword', 'right-password');
      await page.click('#authSubmit');
      await page.locator('#authMsg').waitFor({ state: 'visible', timeout: 10000 });
      assert.match(await page.locator('#authMsg').innerText(), /только у администраторов/);
      // Администратор: семь разделов, меню, обе темы, без горизонтальной прокрутки.
      await page.fill('#authEmail', admin.email);
      await page.fill('#authPassword', 'right-password');
      await page.click('#authSubmit');
      await page.locator('#dash section#sec-audit').waitFor({ state: 'visible', timeout: 15000 });
      const secs = await page.$$eval('#dash section.res-sec', (els) => els.map((e) => e.id));
      assert.deepEqual(secs, ['sec-health', 'sec-http', 'sec-users', 'sec-engine', 'sec-assistant', 'sec-economy', 'sec-base', 'sec-audit']);
      assert.equal(await page.locator('#who').innerText(), admin.email);
      assert.ok((await page.locator('#dash .tile').count()) >= 20, 'плитки');
      assert.ok((await page.locator('#dash .chart svg').count()) >= 4, 'графики');
      const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      // Виновник переполнения — самый широкий элемент, вылезший за край, а не первый попавшийся (docs/testing.md).
      const offenders = async () => page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        return [...document.querySelectorAll('body *')].map((e) => ({ r: e.getBoundingClientRect(), e }))
          .filter((x) => x.r.right > w + 1 && x.r.width > 0).sort((a, b) => b.r.width - a.r.width).slice(0, 8)
          .map((x) => `${x.e.tagName.toLowerCase()}${x.e.id ? '#' + x.e.id : ''}.${[...x.e.classList].join('.')} ${Math.round(x.r.width)}px→${Math.round(x.r.right)}`);
      });
      const noOverflow = async (what) => { const o = await overflow(); assert.equal(o, 0, `горизонтальная прокрутка ${what}: +${o}px; ` + (await offenders()).join(' | ')); };
      await noOverflow('на 1280');
      // Один тумблер темы (role=switch): нажатие переключает, aria-checked — светлая.
      await page.click('#themeToggle');
      assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
      assert.equal(await page.getAttribute('#themeToggle', 'aria-checked'), 'true');
      assert.equal(await page.locator('#themeToggle .tt-txt').innerText(), 'Светлая');
      await noOverflow('в светлой теме');
      await page.setViewportSize({ width: 420, height: 800 });
      await page.waitForTimeout(300);
      await noOverflow('на 420');
      assert.ok(await page.locator('#tabBar').isVisible(), 'панель вкладок на телефоне');
      const navOpen = () => page.evaluate(() => document.body.classList.contains('nav-open'));
      await page.click('#tabMoreBtn', { timeout: 5000 });
      assert.ok(await page.locator('#navPanel').isVisible(), 'меню «Ещё»');
      await page.click('#navPanel .nav-item[data-sec="sec-base"]', { timeout: 5000 });
      await page.waitForTimeout(600);
      assert.ok(!(await navOpen()), 'меню закрылось');
      // Касание мимо меню закрывает его и не доходит до содержимого под подложкой; Escape — тоже.
      await page.click('#tabMoreBtn', { timeout: 5000 });
      await page.mouse.click(210, 300);
      assert.ok(!(await navOpen()), 'касание мимо меню закрывает');
      await page.click('#tabMoreBtn', { timeout: 5000 });
      await page.keyboard.press('Escape');
      assert.ok(!(await navOpen()), 'Escape закрывает');
      // Выход очищает всё и возвращает экран входа.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.click('#accBtn');
      await page.click('#logoutBtn');
      await page.locator('#authViewLogin').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await page.$eval('#dash', (e) => e.querySelectorAll('section').length), 0, 'разделы очищены после выхода');
      assert.deepEqual(errors, [], 'ошибки страницы');
      assert.deepEqual(csps, [], 'нарушения CSP');
      fserver.close();
      console.log('PASS: браузер — отказ не администратору, семь разделов, обе темы, 1280/420 без прокрутки, меню и выход');
    } else {
      console.log('SKIP: браузерная часть (PLAYWRIGHT_MODULE не задан)');
    }
    console.log('PASS: дашборд — 401/403 без сессии и не администратору, вход на имени дашборда только администратору и в своём кругу сессий, код и данные, страница без кода');
  } finally {
    if (browser) await browser.close();
    if (fserver) fserver.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
