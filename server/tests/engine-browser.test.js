// node server/tests/engine-browser.test.js  (нужен PLAYWRIGHT_MODULE)
// Разделы, которые до 17.09.2026 читали базу прямо в браузере, а теперь спрашивают
// /api/engine: сверка источников, виды, калькулятор и партия, спецификация, дерево
// кодов, авто и личные отправления. Плюс гонка ответов при наборе и отказ по лимиту.
// БД подменена, почта не отправляется; страница отдаётся с CSP из nginx.conf.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
if (!process.env.PLAYWRIGHT_MODULE) { console.log('SKIP: задайте PLAYWRIGHT_MODULE'); process.exit(0); }
const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'tnved_checker.html'), 'utf8');
const csp = fs.readFileSync(path.join(__dirname, '../nginx.conf'), 'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1];

const user = { id: 'valid', email: 'test@example.test', role: 'user', active: true, email_verified_at: new Date(), last_seen_at: new Date() };
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async () => ({ rows: [user] }) } } };

// коды с нужными свойствами берём из самой базы, а не из памяти
const B = require('../src/services/base').load();
const codeWhere = (pred) => B.ETT_DB.map((r) => r[0]).find(pred);
const vatFree = codeWhere((c) => c.startsWith('30') && B.vatFreeHits(c).firm.length > 0);
const excise = codeWhere((c) => c.startsWith('2402') && B.findExcise(c).length > 0);
const banned = codeWhere((c) => B.calcWarnings(c).some((w) => w.level === 'red'));
assert.ok(vatFree && excise && banned, `коды для проверки: ${vatFree} ${excise} ${banned}`);
// модель авто, у первого варианта которой есть код ТН ВЭД (тогда расчёт спрашивает предупреждения по коду)
const autoPick = (() => {
  for (const b of B.ENGINE_API.autoBrands()) for (const m of B.ENGINE_API.autoModels(b)) if (B.ENGINE_API.autoVariants(b, m)[0].code) return [b, m];
})();
assert.ok(autoPick, 'модель авто с кодом');

const app = express();
app.use(express.json());
app.use(session({ secret: 'x', resave: false, saveUninitialized: false }));
app.use(require('../src/middleware/auth'));
app.get('/api/auth/config', (q, r) => r.json({}));
app.get('/api/auth/me', (q, r) => (q.user ? r.json({ email: q.user.email, role: q.user.role, emailVerified: true, termsAccepted: true }) : r.status(401).json({})));
app.post('/api/auth/login', (q, r) => { q.session.userId = 'valid'; r.json({ ...user, emailVerified: true, termsAccepted: true }); });
app.get('/api/nbkr-rates', (q, r) => r.json({ date: '17.09.2026', usd: 87.45, eur: 101.2, rates: { USD: 87.45, EUR: 101.2, CNY: 12.3, RUB: 1.08, KZT: 0.17 } }));
app.get('/api/class-decisions', (q, r) => r.json({ results: [], total: 0 }));
app.use('/api/checker.js', require('../src/routes/checker'));
const engineCalls = [];
app.use('/api/engine', (q, r, next) => { engineCalls.push(q.body && q.body.fn); next(); }, require('../src/routes/engine'));
app.get('/', (q, r) => r.set('Content-Security-Policy', csp).type('html').send(html));

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await require(process.env.PLAYWRIGHT_MODULE).chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [], csps = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('__csp', (v) => csps.push(v));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__csp(e.violatedDirective + ' ' + e.blockedURI)));
    await page.goto(origin);
    await page.fill('#authEmail', 'test@example.test');
    await page.fill('#authPassword', 'valid');
    await page.click('#authSubmit');
    await page.locator('#appWrap').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => typeof ETT_DB + typeof findBan + typeof renderHtml), 'undefinedundefinedundefined');

    // сверка источников в боковой панели
    await page.waitForFunction(() => document.querySelectorAll('#srcAudit a').length > 20);
    assert.match(await page.locator('#srcAuditSum').textContent(), /✔ \d+ · ◐ \d+ · ○ \d+/);

    // виды
    await page.click('#navSpeciesBtn');
    await page.fill('#inp', 'Panthera');
    await page.locator('#speciesResult .card').waitFor();
    assert.match(await page.locator('#speciesResult').innerText(), /Найдено видов/);

    // калькулятор: список кодов, выбор, расчёт с НДС 12%
    await page.click('#navCalcBtn');
    await page.fill('#inp', '8517');
    await page.locator('#calcResult .calc-pick').first().waitFor();
    assert.ok(await page.locator('#calcResult .calc-pick').count() > 1);
    await page.locator('#calcResult .calc-pick', { hasText: '8517 13 000 0' }).click();
    await page.locator('#calcValue').waitFor();
    await page.fill('#calcValue', '1000');
    await page.selectOption('#calcCur', 'СОМ');
    await page.locator('#calcResult button', { hasText: 'Рассчитать' }).click();
    await page.locator('#calcOut .calc-total').waitFor();
    assert.match(await page.locator('#calcOut').innerText(), /НДС \(12%/);
    await page.locator('#calcResult button', { hasText: 'В партию' }).click();
    await page.locator('#calcBatchPanel .batch-tbl tbody tr').first().waitFor();

    // освобождённый от НДС код: 0% по перечню № 596
    await page.fill('#inp', vatFree);
    await page.locator('#calcValue').waitFor();
    await page.waitForFunction((c) => document.querySelector('#calcResult .rc') && document.querySelector('#calcResult .rc').textContent.replace(/\D/g, '') === c, vatFree);
    await page.fill('#calcValue', '500');
    await page.selectOption('#calcCur', 'СОМ');
    await page.locator('#calcResult button', { hasText: 'Рассчитать' }).click();
    await page.locator('#calcOut .calc-total').waitFor();
    assert.match(await page.locator('#calcOut').innerText(), /НДС \(0%/);
    await page.locator('#calcResult button', { hasText: 'В партию' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#calcBatchPanel .batch-tbl tbody tr').length === 2);

    // подакцизный код: пункты ст.336 приходят с сервера, подпись поля меняется
    await page.fill('#inp', excise);
    await page.locator('#calcExcIdx').waitFor();
    await page.selectOption('#calcExcIdx', '0');
    assert.match(await page.locator('#calcExcQtyLbl').textContent(), /Количество для акциза, /);

    // запрещённый к ввозу код: красное предупреждение и без формы
    await page.fill('#inp', banned);
    await page.locator('#calcResult .calc-warn.w-red').waitFor();
    assert.equal(await page.locator('#calcValue').count(), 0);

    // партия: расходы пересчитывают итог, требования по кодам — с сервера
    await page.fill('#calcFreightSum', '200');
    await page.waitForFunction(() => /включая расходы/.test(document.querySelector('#calcBatchPanel').innerText));
    assert.ok(await page.locator('#calcBatchPanel .perm-grid, #calcBatchPanel .batch-empty').count() > 0);
    // условие поставки: DDP без вычетов — расчёт помечен завышенным; вычет уменьшает стоимость и снимает пометку; FOB без расходов — занижен
    await page.selectOption('#calcIncoterm', 'DDP');
    await page.waitForFunction(() => /DDP: в цене уже сидят/.test(document.querySelector('#calcBatchPanel').innerText));
    await page.fill('#calcDeduct', '100');
    await page.locator('#calcDeduct').blur();
    await page.waitForFunction(() => { const t = document.querySelector('#calcBatchPanel').innerText; return /за вычетом 100,00 сом/.test(t) && !/завышен/.test(t); });
    await page.fill('#calcDeduct', '');
    await page.locator('#calcDeduct').blur();
    await page.fill('#calcFreightSum', '');
    await page.selectOption('#calcIncoterm', 'FOB');
    await page.waitForFunction(() => /FOB: перевозка до границы ЕАЭС.*занижены/.test(document.querySelector('#calcBatchPanel').innerText));
    await page.selectOption('#calcIncoterm', '');

    // спецификация: готовая строка, код вне ЕТТ с подсказкой, неоднозначный код
    const csv = 'Код;Наименование;Стоимость;Валюта\n8517130000;телефон;1000;USD\n9999999999;нет;10;USD\n8517;неточно;10;USD\n';
    await page.setInputFiles('#specFile', { name: 'spec.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await page.locator('#activeModal .spec-tbl tbody tr').nth(2).waitFor();
    const spec = await page.locator('#activeModal .spec-tbl').innerText();
    assert.match(spec, /готово/);
    assert.match(spec, /кода нет в ЕТТ|код не найден в ЕТТ/);
    assert.match(spec, /неоднозначен/);
    await page.locator('#activeModal .calc-btn', { hasText: 'Добавить 1' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#calcBatchPanel .batch-tbl tbody tr').length === 3);

    // дерево: группа 84 по 50 строк, «Показать ещё», переход к коду с подсветкой
    await page.click('#navTreeBtn');
    await page.evaluate(() => renderTreeChapter('84'));
    await page.waitForFunction(() => document.querySelectorAll('#pageTree .ett-row').length === 50);
    await page.locator('#pageTree button', { hasText: 'Показать ещё' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#pageTree .ett-row').length === 100);
    await page.evaluate(() => showInTree('8517130000'));
    await page.locator('#treeRow8517130000.notes-hl').waitFor();

    // авто: марка → модель → вариант из прайс-листа → расчёт
    await page.click('#navAutoBtn');
    await page.waitForFunction(() => document.querySelectorAll('#acBrand option').length > 5);
    await page.selectOption('#acBrand', autoPick[0]);
    await page.waitForFunction(() => !document.getElementById('acModel').disabled && document.querySelectorAll('#acModel option').length > 1);
    await page.selectOption('#acModel', autoPick[1]);
    await page.waitForFunction(() => !document.getElementById('acVariant').disabled && document.getElementById('acVolume').value !== '');
    if (!(await page.inputValue('#acValue'))) await page.fill('#acValue', '15000');
    if (!(await page.inputValue('#acEurRate'))) await page.fill('#acEurRate', '101.2');
    if (!(await page.inputValue('#acCurRate').catch(() => ''))) await page.fill('#acCurRate', '87.45').catch(() => {});
    await page.locator('#autoCalcPanel .calc-btn', { hasText: 'Рассчитать' }).click();
    await page.locator('#acOut .calc-total').waitFor();

    // личные отправления: отчёт о сверке нормы приходит с сервера
    await page.click('#navPersonalBtn');
    await page.fill('#pcValue', '1500');
    await page.fill('#pcWeight', '20');
    await page.fill('#pcEurRate', '101.2');
    await page.locator('#personalCalcPanel .calc-btn', { hasText: 'Рассчитать' }).click();
    await page.locator('#pcOut .calc-total').waitFor();
    assert.ok(await page.locator('#pcOut .audit-det').count() > 0);

    // гонка: ответ на «8517» задержан и приходит после ответа на «8703231910» — на экране остаётся последний запрос
    await page.click('#navSearchBtn');
    await page.route('**/api/engine', async (route) => {
      if (/"8517"/.test(route.request().postData() || '')) await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.fill('#inp', '8517');
    await page.waitForTimeout(400);
    await page.fill('#inp', '8703231910');
    await page.locator('#result .card').first().waitFor();
    await page.waitForTimeout(2000);
    assert.match(await page.locator('#result').innerText(), /8703 23 191 0/);
    assert.doesNotMatch(await page.locator('#result').innerText(), /8517 1/);
    await page.unroute('**/api/engine');

    // отказ по лимиту — понятное сообщение вместо пустой выдачи
    await page.route('**/api/engine', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'engine_limit_day' }) }));
    await page.fill('#inp', '0402');
    await page.locator('#result .nf', { hasText: 'Суточный лимит' }).waitFor();
    await page.unroute('**/api/engine');

    // выход в той же вкладке: checker.js остаётся загруженным, поэтому партия, условие поставки, строки спецификации и
    // панели калькулятора прошлого пользователя должны быть стёрты resetAppView() — иначе их увидит следующий вошедший
    assert.ok(await page.evaluate(() => calcBatch.length) > 0, 'партия к этому месту не пуста');
    await page.evaluate(() => { calcFreight.term = 'DDP'; specPending = [{ code: '1' }]; return doLogout(); });
    assert.deepEqual(await page.evaluate(() => [calcBatch.length, calcFreight.term, specPending.length,
      ...['calcBatchPanel', 'calcResult', 'autoCalcPanel', 'personalCalcPanel'].map((id) => document.getElementById(id).innerHTML)]), [0, '', 0, '', '', '', '']);

    assert.deepEqual(errors, []);
    assert.deepEqual(csps, []);
    for (const fn of ['sourceAuditHtml', 'speciesHtml', 'calcCodeList', 'codeBundle', 'specLookup', 'treeChapter', 'autoBrands', 'autoModels', 'autoVariants', 'calcWarnings', 'auditNote', 'renderHtml']) {
      assert.ok(engineCalls.includes(fn), 'вызов ' + fn);
    }
    console.log('PASS: браузер — сверка, виды, калькулятор и партия, спецификация, дерево, авто, личные отправления, гонка ответов, лимит');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
