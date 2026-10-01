// node server/tests/a11y.test.js  (нужны PLAYWRIGHT_MODULE и axe-core рядом с playwright-core: npm i axe-core; иначе — SKIP)
// Автоматическая проверка доступности (axe-core, правила WCAG 2.0/2.1 A и AA + best-practice) на экране входа и в разделах
// приложения: 1280 и 390 px, светлая и тёмная тема. Нарушений быть не должно: контраст в обеих темах, подписи полей и кнопок,
// ориентиры страницы (main, navigation, banner, contentinfo) и заголовок первого уровня — для программ чтения с экрана.
// До 01.10.2026 у приложения не было ни main, ни h1 (axe: landmark-one-main, page-has-heading-one, region на 130+ узлов).
// Это машинная проверка: она не заменяет проход с настоящей программой чтения и клавиатурой.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');

if (!process.env.PLAYWRIGHT_MODULE) {
  console.log('SKIP: нужен PLAYWRIGHT_MODULE (браузер)');
  process.exit(0);
}
const AXE = process.env.AXE_CORE || path.join(path.dirname(process.env.PLAYWRIGHT_MODULE), 'axe-core', 'axe.min.js');
if (!fs.existsSync(AXE)) {
  console.log('SKIP: нет axe-core (' + AXE + ') — npm i axe-core рядом с playwright-core');
  process.exit(0);
}
const axeSource = fs.readFileSync(AXE, 'utf8');
const PORT = 26000 + Math.floor(Math.random() * 1000);
process.env.APP_ORIGIN = 'http://127.0.0.1:' + PORT;
process.env.SESSION_SECRET = 'local-check-only';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;
delete process.env.TURNSTILE_SECRET_KEY;

const user = { id: '22222222-2222-4222-8222-222222222222', email: 'user@test.local', password_hash: bcrypt.hashSync('user-password', 4), role: 'user', active: true,
  email_verified_at: new Date(), subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: '2026-09-18', totp_secret: null, totp_enabled_at: null };
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, a = []) => {
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: [user].filter((u) => u.id === a[0] || u.email === a[0]) };
  return { rows: [], rowCount: 0 };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };
const app = require('../src/index');

// Правила, которые не считаем нарушениями, — только с причиной. Пусто: все найденное исправлено.
const IGNORED = {};

async function scan(page, label, found) {
  // Карточки и переходы темы плавно проявляются: axe, снявший цвет посреди перехода, видит полупрозрачный текст и ругается на
  // контраст там, где в покое он достаточен (случай 01.10.2026: .t-ett.tag в тёмной теме один прогон из трёх). Сначала дожидаемся
  // конца всех анимаций и переходов.
  // (бесконечные анимации — индикаторы загрузки — не ждём: у них нет конца; и общий предел 3 с, чтобы проверка не зависла)
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((a) => { try { return Number.isFinite(a.effect.getComputedTiming().endTime); } catch (e) { return false; } }).map((a) => a.finished.catch(() => {}))),
    new Promise((r) => setTimeout(r, 3000)),
  ]));
  await page.waitForTimeout(150);
  await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => {
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: (v.nodes[0].target || []).join(' ').slice(0, 100) }));
  });
  for (const v of violations) if (!IGNORED[v.id]) found.push(`${label}: ${v.id} (${v.impact}) ×${v.n}, например ${v.sample}`);
  return violations.length;
}

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = 'http://127.0.0.1:' + PORT;
  const browser = await require('./browser').launch();
  const found = [];
  let views = 0;
  try {
    for (const [w, theme] of [[1280, 'light'], [390, 'light'], [390, 'dark'], [1280, 'dark']]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
      await ctx.addInitScript((t) => { try { localStorage.setItem('ca-theme', t); } catch (e) { /* хранилище закрыто */ } }, theme);
      const page = await ctx.newPage();
      const tag = `${w}/${theme}`;
      await page.goto(origin + '/');
      await page.locator('#authEmail').waitFor({ state: 'visible' });
      await scan(page, tag + ' вход', found); views++;
      await page.locator('#authRegisterLink').click();
      await page.locator('#authViewRegister').waitFor({ state: 'visible' });
      await scan(page, tag + ' регистрация', found); views++;
      await page.locator('#authRegisterBackLink').click();
      await page.locator('#authForgotLink').click();
      await page.locator('#authViewForgot').waitFor({ state: 'visible' });
      await scan(page, tag + ' восстановление', found); views++;
      await page.locator('#authBackToLoginLink').click();
      await page.locator('#authEmail').fill(user.email);
      await page.locator('#authPassword').fill('user-password');
      await page.locator('#authSubmit').click();
      await page.locator('#appWrap').waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
      await scan(page, tag + ' поиск', found); views++;
      await page.fill('#inp', '8517130000');
      await page.waitForFunction(() => /^8517130000\|/.test(document.getElementById('result').dataset.rq || ''), null, { timeout: 30000 });
      await scan(page, tag + ' результат по коду', found); views++;
      await page.evaluate(() => { setPage('search'); setSearchMode('calc'); });
      await page.waitForTimeout(300);
      await scan(page, tag + ' калькулятор', found); views++;
      await page.evaluate(() => setPage('tree'));
      await page.waitForTimeout(600);
      await scan(page, tag + ' классификатор', found); views++;
      await page.evaluate(() => setPage('ai'));
      await page.waitForTimeout(400);
      await scan(page, tag + ' помощник', found); views++;
      await ctx.close();
    }
    assert.deepEqual(found, [], 'нарушения доступности:\n  ' + found.join('\n  '));
    console.log(`PASS: доступность (axe-core ${JSON.parse(fs.readFileSync(path.join(path.dirname(AXE), 'package.json'), 'utf8')).version}) — ${views} видов (экран входа, регистрация, восстановление, поиск, результат, калькулятор, классификатор, помощник × 1280/390 px × две темы): нарушений нет`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
