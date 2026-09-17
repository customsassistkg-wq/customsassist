// node server/tests/assistant-browser.test.js  (нужен PLAYWRIGHT_MODULE)
// AI-помощник в Edge: вход, вопрос, шаги в потоке, Markdown-ответ, переход по
// коду, оценка, переписка после перезагрузки, ширина 1280/420, очистка при выходе.
// Модель и БД подменены — сеть, баланс DeepSeek и Postgres не нужны.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
if (!process.env.PLAYWRIGHT_MODULE) { console.log('SKIP: задайте PLAYWRIGHT_MODULE'); process.exit(0); }
const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'tnved_checker.html'), 'utf8');
process.env.AI_API_KEY = 'test';

const user = { id: 'valid', email: 'test@example.test', role: 'user', active: true, email_verified_at: new Date(), last_seen_at: new Date() };
const db = { inserts: 0, rated: null };
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, params) => {
  if (/insert into assistant_log/.test(sql)) { db.inserts++; return { rows: [{ id: 42 }] }; }
  if (/count\(\*\)::int as used/.test(sql)) return { rows: [{ used: db.inserts, used_today: db.inserts }] };
  if (/update assistant_log/.test(sql)) { db.rated = params; return { rowCount: 1 }; }
  return { rows: [user] };
} } } };

let n = 0;
let lastFirstRequest = null;
// 2×2 PNG: браузер сожмёт его в JPEG, сервер передаст модели блоком image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
global.fetch = async (url, opts) => {
  n++;
  const b = JSON.parse(opts.body);
  if (b.tool_choice) lastFirstRequest = b;
  // задержка, чтобы шаг «Ищу в базе» успел дойти до браузера раньше ответа
  if (!b.tool_choice) await new Promise((r) => setTimeout(r, 400));
  const content = b.tool_choice
    ? [{ type: 'tool_use', id: 't' + n, name: 'search_base', input: { query: '8517130000' } }]
    : [{ type: 'text', text: '### Результат\n**Код:** 8517 13 000 0\n- Пошлина: 0%\n- ' + 'длинноесловобезпробелов'.repeat(8) }];
  return { ok: true, json: async () => ({ content, usage: { input_tokens: 1, output_tokens: 1 } }) };
};

const app = express();
app.use(express.json());
app.use(session({ secret: 'x', resave: false, saveUninitialized: false }));
app.use(require('../src/middleware/auth'));
app.get('/api/auth/config', (q, r) => r.json({}));
// как настоящий /api/auth/me — без id: переписка должна восстанавливаться по email
app.get('/api/auth/me', (q, r) => (q.user ? r.json({ email: q.user.email, role: q.user.role, emailVerified: true }) : r.status(401).json({})));
app.post('/api/auth/login', (q, r) => { q.session.userId = 'valid'; r.json({ ...user, emailVerified: true }); });
app.post('/api/auth/logout', (q, r) => q.session.destroy(() => r.json({})));
app.get('/api/nbkr-rates', (q, r) => r.status(503).json({}));
app.get('/api/class-decisions', (q, r) => r.json({ items: [] }));
app.use('/api/checker.js', require('../src/routes/checker'));
app.use('/api/engine', require('../src/routes/engine'));
app.use('/api/assistant', require('../src/routes/assistant'));
app.get('/', (q, r) => r.type('html').send(html));

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await require(process.env.PLAYWRIGHT_MODULE).chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const w of [1280, 420]) {
      const page = await browser.newPage({ viewport: { width: w, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(origin);
      await page.fill('#authEmail', 'test@example.test');
      await page.fill('#authPassword', 'valid');
      await page.click('#authSubmit');
      await page.locator('#appWrap').waitFor({ state: 'visible' });
      await page.click('#navAiBtn');
      await page.locator('#aiInput').waitFor({ state: 'visible' });

      // фото инвойса: миниатюра появляется, уходит вместе с вопросом, в пузыре — отметка
      await page.setInputFiles('#aiFile', { name: 'invoice.png', mimeType: 'image/png', buffer: PNG });
      await page.locator('.ai-thumb img').waitFor();
      await page.fill('#aiInput', 'Пошлина на смартфон?');
      await page.keyboard.press('Enter');
      // шаг инструмента виден, пока модель ещё отвечает
      await page.locator('.ai-msg.a', { hasText: 'Ищу в базе' }).waitFor();
      await page.locator('.ai-msg.a h4').waitFor();
      const r = await page.evaluate(() => ({
        h: document.querySelector('.ai-msg.a:last-child').innerHTML,
        msgs: document.querySelectorAll('.ai-msg').length,
        over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }));
      assert.match(r.h, /class="ai-code" data-code="8517130000"/);
      assert.match(r.h, /Поиск в базе: 8517130000/);
      assert.match(r.h, /class="ai-rate" data-id="42"/);
      assert.match(await page.locator('#aiQuota').innerText(), /Тариф «Базовый»: сегодня осталось \d+ из 3 · в месяц \d+ из 100/);
      assert.equal(r.msgs, 2);
      const lastUser = lastFirstRequest.messages[lastFirstRequest.messages.length - 1];
      assert.equal(lastUser.content[0].type, 'image');
      assert.equal(lastUser.content[0].source.media_type, 'image/jpeg');
      assert.equal(lastUser.content[1].text, 'Пошлина на смартфон?');
      assert.match(await page.locator('.ai-msg.u').innerText(), /изображений: 1/);
      assert.equal(await page.locator('.ai-thumb').count(), 0);
      assert.equal(r.over, false, 'horizontal overflow at ' + w);
      if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/ai_' + w + '.png' });

      // 👎 с комментарием уходит на сервер и подсвечивается
      await page.click('.ai-down');
      await page.fill('.ai-why input', 'не тот код');
      await page.click('.ai-why button');
      await page.locator('.ai-why', { hasText: 'Спасибо' }).waitFor();
      assert.deepEqual(db.rated, [-1, 'не тот код', 42, 'valid']);
      assert.ok(await page.evaluate(() => document.querySelector('.ai-down').classList.contains('on')));

      // переписка переживает перезагрузку вкладки
      await page.reload();
      await page.locator('#appWrap').waitFor({ state: 'visible' });
      await page.click('#navAiBtn');
      await page.locator('.ai-msg.a h4').waitFor();
      assert.equal(await page.evaluate(() => document.querySelectorAll('.ai-msg').length), 2);

      // код в ответе открывает карточку в поиске
      await page.click('.ai-msg.a .ai-code');
      await page.locator('#pageSearch').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => currentPage), 'search');

      // выход стирает переписку и в DOM, и в sessionStorage
      await page.evaluate(() => doLogout());
      await page.locator('#authScreen').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.getElementById('pageAi').innerHTML + aiHistory.length
        + Object.keys(sessionStorage).filter((k) => k.startsWith('ca-ai-')).length), '00');
      assert.deepEqual(errors, []);
      console.log('PASS browser', w);
      await page.close();
    }
    assert.equal(db.inserts, 2);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
