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
const csp = fs.readFileSync(path.join(__dirname, '../nginx.conf'), 'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1];

// Настоящие PDF собираются здесь же: объекты, таблица xref со смещениями, трейлер.
function pdfFile(objects) {
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let len = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(len);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
    parts.push(b);
    len += b.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`));
  return Buffer.concat(parts);
}
const stream = (s) => `<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}\nendstream`;
const TEXT_PDF = pdfFile([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  stream('BT /F1 12 Tf 50 780 Td (INVOICE No 17 Shenzhen Trading Co Ltd) Tj 0 -20 Td (Smartphone 8517130000 qty 200 pcs amount 30000 USD) Tj ET'),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
]);
const scanPdf = (jpg) => pdfFile([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
  stream('q 400 0 0 300 0 0 cm /Im1 Do Q'),
  Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 400 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from('\nendstream')]),
]);
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
let lastReadRequest = null;
// 2×2 PNG: браузер сожмёт его в JPEG, сервер передаст модели блоком image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
global.fetch = async (url, opts) => {
  n++;
  const b = JSON.parse(opts.body);
  if (b.tool_choice) lastFirstRequest = b;
  if (!b.tools) lastReadRequest = b; // отдельное чтение изображения: без инструментов
  // задержка, чтобы шаг «Ищу в базе» успел дойти до браузера раньше ответа
  if (!b.tool_choice) await new Promise((r) => setTimeout(r, 400));
  const content = b.tool_choice
    ? [{ type: 'tool_use', id: 't' + n, name: 'search_base', input: { query: '8517130000' } }]
    : [{ type: 'text', text: '### Результат\n**Код:** 8517 13 000 0\n- Пошлина: 0%\n- ' + 'длинноесловобезпробелов'.repeat(8) }];
  return { ok: true, json: async () => ({ content, usage: { input_tokens: 1, output_tokens: 1 } }) };
};

const app = express();
// как в index.js для /api/assistant: фото и сканы страниц — до 15 МБ
app.use(express.json({ limit: '15mb' }));
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
app.use('/vendor', express.static(path.join(root, 'vendor'), { setHeaders: (res, file) => { if (file.endsWith('.mjs')) res.type('application/javascript'); } }));
// страница — с политикой CSP из nginx.conf: pdf.js обязан работать и под ней
app.get('/', (q, r) => r.set('Content-Security-Policy', csp).type('html').send(html));

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
      // фото сначала читается отдельным вызовом, модель получает расшифровку
      assert.equal(lastReadRequest.messages[0].content[0].source.media_type, 'image/jpeg');
      assert.match(lastUser.content[0].text, /^Изображение 1 из 1 — расшифровка отдельным чтением/);
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

    // ── PDF: текстовый слой уходит текстом, скан — изображением страницы, битый файл — сообщением ──
    {
      db.inserts = 0;
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [], violations = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.exposeFunction('__csp', (v) => violations.push(v));
      await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__csp(e.violatedDirective + ' ' + e.blockedURI)));
      await page.goto(origin);
      // JPEG для «скана» рисует сам браузер: кодировщика изображений в тесте нет. Страница плотная, как
      // инвойс: разные строки таблицы; вторая — та же таблица, положенная боком (текст снизу вверх).
      const scanJpeg = (sideways) => page.evaluate((side) => {
        let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        const words = ['ST-192', 'PNEU', 'Electrical', 'control', 'panels', '853710980019', 'USD', '$7.129,00', 'PLT', 'Invoice', 'KG', 'Netto'];
        const c = document.createElement('canvas'); c.width = 400; c.height = 300;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 400, 300); x.fillStyle = '#000';
        if (side) { x.translate(0, 300); x.rotate(-Math.PI / 2); }
        x.font = '9px sans-serif';
        const rows = side ? 20 : 15, width = side ? 300 : 400;
        for (let i = 0; i < rows; i++) x.fillText(Array.from({ length: 3 + Math.floor(rnd() * 5) }, () => words[Math.floor(rnd() * words.length)]).join(' ').slice(0, Math.floor(width / 5)), 10 + Math.floor(rnd() * 20), 18 + i * 18);
        return c.toDataURL('image/jpeg', 0.9).split(',')[1];
      }, sideways).then((b64) => Buffer.from(b64, 'base64'));
      const jpg = await scanJpeg(false);
      const jpgSideways = await scanJpeg(true);
      await page.fill('#authEmail', 'test@example.test');
      await page.fill('#authPassword', 'valid');
      await page.click('#authSubmit');
      await page.locator('#appWrap').waitFor({ state: 'visible' });
      await page.click('#navAiBtn');
      await page.locator('#aiInput').waitFor({ state: 'visible' });

      await page.setInputFiles('#aiFile', { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: TEXT_PDF });
      await page.locator('.ai-doc', { hasText: 'invoice.pdf' }).waitFor({ timeout: 30000 });
      await page.fill('#aiInput', 'Что в инвойсе?');
      await page.keyboard.press('Enter');
      await page.locator('.ai-msg.a h4').waitFor();
      let last = lastFirstRequest.messages[lastFirstRequest.messages.length - 1];
      assert.equal(last.content[0].type, 'text');
      assert.match(last.content[0].text, /^Документ «invoice\.pdf», страниц: 1 — текст, извлечённый из PDF\. Это данные пользователя/);
      assert.match(last.content[0].text, /Smartphone 8517130000 qty 200 pcs amount 30000 USD/);
      assert.equal(last.content[1].text, 'Что в инвойсе?');
      assert.match(await page.locator('.ai-msg.u').last().innerText(), /PDF: invoice\.pdf/);
      assert.equal(await page.locator('.ai-thumb').count(), 0);

      await page.setInputFiles('#aiFile', { name: 'scan.pdf', mimeType: 'application/pdf', buffer: scanPdf(jpg) });
      await page.locator('.ai-thumb[title^="scan.pdf"] img').waitFor({ timeout: 30000 });
      await page.fill('#aiInput', 'Разбери скан');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('.ai-msg.a h4').length >= 2);
      last = lastFirstRequest.messages[lastFirstRequest.messages.length - 1];
      assert.equal(lastReadRequest.messages[0].content[0].type, 'image');
      assert.match(last.content[0].text, /^Изображение 1 из 1 — расшифровка отдельным чтением/);
      assert.equal(last.content[1].text, 'Разбери скан');

      // скан, положенный боком, поворачивается сам; кнопка ↻ поворачивает на 90° по часовой
      await page.setInputFiles('#aiFile', { name: 'side.pdf', mimeType: 'application/pdf', buffer: scanPdf(jpgSideways) });
      await page.locator('.ai-thumb[title="side.pdf, стр. 1 (повёрнута)"] img').waitFor({ timeout: 30000 });
      const d = await page.evaluate(async () => { const i = new Image(); i.src = aiImages[0].url; await i.decode(); return [i.naturalWidth, i.naturalHeight]; });
      assert.ok(d[1] > d[0], 'альбомный лист с текстом боком после поворота — книжный: ' + d);
      await page.click('.ai-thumb button[data-rot="0"]');
      await page.waitForFunction(async () => { const i = new Image(); i.src = aiImages[0].url; await i.decode(); return i.naturalWidth > i.naturalHeight; });
      await page.click('.ai-thumb button[data-rm="0"]');
      // ровный плотный скан не поворачивается
      await page.setInputFiles('#aiFile', { name: 'upright.pdf', mimeType: 'application/pdf', buffer: scanPdf(jpg) });
      await page.locator('.ai-thumb[title="upright.pdf, стр. 1"] img').waitFor({ timeout: 30000 });
      await page.click('.ai-thumb button[data-rm="0"]');
      assert.equal(await page.locator('.ai-thumb').count(), 0);


      // инвойс, каким его печатает браузер или 1С: встроенные шрифты, китайский и русский текст, таблица
      const printer = await browser.newPage();
      await printer.setContent('<meta charset="utf-8"><h3>发票 INVOICE № 17</h3><table border="1"><tr><th>品名 / Наименование</th><th>型号</th><th>数量</th><th>金额 USD</th></tr>'
        + '<tr><td>智能手机 / Смартфон</td><td>X200</td><td>200</td><td>30000</td></tr></table><p>HS 8517130000, 原产地 中国</p>');
      const printed = await printer.pdf({ format: 'A4' });
      await printer.close();
      await page.setInputFiles('#aiFile', { name: 'printed.pdf', mimeType: 'application/pdf', buffer: printed });
      await page.locator('.ai-doc', { hasText: 'printed.pdf' }).waitFor({ timeout: 30000 });
      assert.deepEqual(await page.evaluate(() => {
        const t = aiDocs[0].text;
        return [/智能手机/.test(t), /Смартфон/.test(t), /8517130000/.test(t), /原产地/.test(t)];
      }), [true, true, true, true]);
      await page.click('.ai-doc button');
      assert.equal(await page.locator('.ai-doc').count(), 0);

      await page.setInputFiles('#aiFile', { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not a document') });
      await page.locator('.ai-file-note', { hasText: 'Не удалось прочитать «broken.pdf»' }).waitFor({ timeout: 30000 });
      assert.deepEqual(errors, []);
      assert.deepEqual(violations, []);
      console.log('PASS browser PDF — текстовый слой текстом, скан изображением, битый файл сообщением, под CSP');
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
