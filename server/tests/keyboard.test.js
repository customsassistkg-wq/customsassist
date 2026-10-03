// node server/tests/keyboard.test.js  (нужен PLAYWRIGHT_MODULE; иначе SKIP)
// Клавиатура (04.10.2026): всё, что на странице открывается кликом, открывается и с клавиатуры. До этого строки списка «найдено по
// наименованию», строки ЕТТ и классификатора, хлебные крошки дерева, заголовки сворачиваемых карточек и заголовок свёрнутой секции
// «справочно» были div, span и h2 с обработчиком мыши: ни Tab, ни Enter их не видели, а axe-core такого не находит (он не знает про обработчики).
// Теперь у них role="button" и tabindex="0" (заголовок секции — настоящая кнопка внутри h2), состояния карточек и секции — в aria-expanded,
// Enter и пробел нажимают их (один обработчик в initApp), а значок «пояснения» внутри строки — только для мыши (aria-hidden), чтобы кнопки не
// вкладывались одна в другую. Проверка идёт по настоящей странице: Tab от поля поиска доходит до строки, Enter открывает код, пробел не прокручивает.
// Там же — уменьшение движения (prefers-reduced-motion, 04.10.2026): переходы и анимации мгновенные, прокрутка не плавная (smoothOrAuto).
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

if (!process.env.PLAYWRIGHT_MODULE) {
  console.log('SKIP: нужен PLAYWRIGHT_MODULE (браузер)');
  process.exit(0);
}
const PORT = 27000 + Math.floor(Math.random() * 1000);
process.env.APP_ORIGIN = 'http://127.0.0.1:' + PORT;
process.env.SESSION_SECRET = 'local-check-only';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;
delete process.env.TURNSTILE_SECRET_KEY;

const user = { id: '22222222-2222-4222-8222-222222222222', email: 'user@test.local', password_hash: bcrypt.hashSync('user-password', 4), role: 'user', active: true,
  email_verified_at: new Date(), subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: require('./terms-version'), totp_secret: null, totp_enabled_at: null };
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, a = []) => {
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: [user].filter((u) => u.id === a[0] || u.email === a[0]) };
  return { rows: [], rowCount: 0 };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };
const app = require('../src/index');

// Всё, что кликается, но не кнопка/ссылка/поле, обязано быть role="button" tabindex="0"; значки-подсказки внутри строк (aria-hidden) — мышиные.
const AUDIT = () => [...document.querySelectorAll('[onclick]')]
  .filter((e) => !/^(BUTTON|A|INPUT|SELECT|SUMMARY|LABEL|TEXTAREA)$/.test(e.tagName) && e.getAttribute('aria-hidden') !== 'true')
  .filter((e) => e.getAttribute('role') !== 'button' || e.getAttribute('tabindex') !== '0')
  .map((e) => e.tagName.toLowerCase() + '.' + (e.className || '') + ' «' + (e.textContent || '').trim().slice(0, 30) + '»');

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const browser = await require('./browser').launch();
  const checked = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:' + PORT + '/');
    await page.locator('#authEmail').waitFor({ state: 'visible' });
    await page.locator('#authEmail').fill(user.email);
    await page.locator('#authPassword').fill('user-password');
    await page.locator('#authSubmit').click();
    await page.locator('#appWrap').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    const audit = async (label) => {
      const bad = await page.evaluate(AUDIT);
      assert.deepEqual(bad, [], label + ': кликабельные элементы без role="button" и tabindex="0"');
      checked.push(label);
    };
    // Ждём ответ именно на этот запрос: data-rq ставится последним, после карточек, фильтра и вердикта. Одного селектора мало — его удовлетворяют карточки
    // прошлого запроса, ещё стоящие на экране: тест фокусировал их, а пришедший ответ перестраивал узлы, и Enter «не открывал» карточку (один раз в общем
    // прогоне проверок, пока рядом шли тяжёлые расчёты, 04.10.2026; в одиночку и под искусственной нагрузкой не повторялось — причина по ходу событий, не по замеру).
    const search = async (q, stamped = true) => {
      await page.fill('#inp', q); await page.keyboard.press('Enter');
      if (stamped) await page.waitForFunction((s) => (document.getElementById('result').dataset.rq || '').startsWith(s + '|'), q, { timeout: 30000 });
    };
    const tabTo = async (selector, max = 120) => {
      for (let i = 0; i < max; i++) {
        if (await page.evaluate((s) => !!document.activeElement && document.activeElement.matches(s), selector)) return i;
        await page.keyboard.press('Tab');
      }
      throw new Error('Tab не дошёл до ' + selector + ' за ' + max + ' нажатий');
    };
    const codeOfRow = (sel) => page.evaluate((s) => /goToCode\('(\d+)'\)/.exec(document.querySelector(s).getAttribute('onclick'))[1], sel);

    // 1. Список «найдено по наименованию»: Tab от поля поиска доходит до строки, Enter открывает код, пробел — тоже и не прокручивает страницу.
    await search('аккумулятор автомобильный');
    await page.waitForSelector('#result .usir-row[role="button"]', { timeout: 30000 });
    await audit('список по наименованию');
    await page.focus('#inp');
    await page.keyboard.press('Tab');
    const tabs = await tabTo('.usir-row');
    assert.ok(tabs < 120);
    const first = await page.evaluate(() => /goToCode\('(\d+)'\)/.exec(document.activeElement.getAttribute('onclick'))[1]);
    await page.keyboard.press('Enter');
    await page.waitForFunction((c) => document.getElementById('inp').value === c && (document.getElementById('result').dataset.rq || '').startsWith(c), first, { timeout: 30000 });
    // второй раз — пробелом по второй строке
    await search('аккумулятор автомобильный');
    await page.waitForSelector('#result .usir-row[role="button"]', { timeout: 30000 });
    const second = await page.evaluate(() => /goToCode\('(\d+)'\)/.exec(document.querySelectorAll('#result .usir-row')[1].getAttribute('onclick'))[1]);
    await page.evaluate(() => document.querySelectorAll('#result .usir-row')[1].focus());
    const y0 = await page.evaluate(() => window.scrollY);
    // слушатель после приложения (тот же узел и фаза — срабатывает позже): видит, погасило ли приложение действие клавиши по умолчанию (прокрутку)
    await page.evaluate(() => { window.__kbPrevented = null; document.addEventListener('keydown', (e) => { window.__kbPrevented = e.defaultPrevented; }); });
    await page.keyboard.press(' ');
    assert.equal(await page.evaluate(() => window.__kbPrevented), true, 'пробел на кнопке гасит прокрутку страницы (preventDefault)');
    await page.waitForFunction((c) => document.getElementById('inp').value === c && (document.getElementById('result').dataset.rq || '').startsWith(c), second, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.scrollY), y0, 'пробел на кнопке не прокручивает страницу');
    assert.notEqual(first, second);

    // 2. Результат по коду: заголовки карточек — кнопки с aria-expanded; Enter и пробел открывают и закрывают; «развернуть все» согласовано.
    await search('8517130000');
    await page.waitForSelector('#result .card.collapsible .rh[role="button"]', { timeout: 30000 });
    await audit('результат по коду');
    const state = () => page.evaluate(() => [...document.querySelectorAll('#result .card.collapsible')].map((c) => [c.classList.contains('open'), c.querySelector(':scope > .rh').getAttribute('aria-expanded')]));
    let st = await state();
    assert.ok(st.length >= 5 && st.every(([o, a]) => o === false && a === 'false'), 'все карточки свёрнуты, aria-expanded="false"');
    await page.evaluate(() => document.querySelector('#result .card.collapsible > .rh').focus());
    await page.keyboard.press('Enter');
    st = await state();
    assert.deepEqual(st[0], [true, 'true'], 'Enter открывает карточку');
    await page.keyboard.press(' ');
    st = await state();
    assert.deepEqual(st[0], [false, 'false'], 'пробел закрывает карточку');
    await page.click('#expandAllBtn');
    st = await state();
    assert.ok(st.every(([o, a]) => o === true && a === 'true'), '«развернуть все» открывает все и меняет aria-expanded');
    await page.click('#expandAllBtn');
    st = await state();
    assert.ok(st.every(([o, a]) => o === false && a === 'false'));
    // шеврон — не для чтения с экрана
    assert.equal(await page.evaluate(() => document.querySelector('#result .card-chevron').getAttribute('aria-hidden')), 'true');
    // переход из вердикта (чип «нужен документ») открывает карточку и согласует aria-expanded
    if (await page.evaluate(() => !!document.querySelector('#resultSummary .vd-need'))) {
      await page.evaluate(() => document.querySelector('#resultSummary .vd-need').click());
      st = await state();
      assert.ok(st.some(([o, a]) => o === true && a === 'true') && st.every(([o, a]) => String(o) === (a === 'true' ? 'true' : 'false')), 'чип вердикта: класс и aria-expanded согласованы');
    }

    // 3. Свёрнутая секция «справочно»: заголовок — кнопка внутри h2; Enter раскрывает, aria-expanded меняется, переход из вердикта тоже.
    const sec = () => page.evaluate(() => { const s = document.getElementById('res-sec-info'); return [s.classList.contains('open'), s.querySelector('.res-sec-btn').getAttribute('aria-expanded')]; });
    assert.equal(await page.evaluate(() => document.querySelector('#res-sec-info h2 > button.res-sec-btn') !== null), true, 'кнопка внутри заголовка h2');
    assert.deepEqual(await sec(), [false, 'false']);
    await page.evaluate(() => document.querySelector('#res-sec-info .res-sec-btn').focus());
    await page.keyboard.press('Enter');
    assert.deepEqual(await sec(), [true, 'true']);
    await page.keyboard.press('Enter');
    assert.deepEqual(await sec(), [false, 'false']);
    await page.evaluate(() => focusResultSec('info'));
    assert.deepEqual(await sec(), [true, 'true'], 'переход из вердикта открывает секцию и ставит aria-expanded');

    // 4. Позиция ЕТТ (строки подсубпозиций) и дерево классификатора: строки и хлебные крошки.
    await search('8504');
    await page.waitForSelector('#result .ett-row[role="button"]', { timeout: 30000 });
    await audit('строки ЕТТ позиции');
    const rowCode = await codeOfRow('#result .ett-row');
    await page.evaluate(() => document.querySelector('#result .ett-row').focus());
    await page.keyboard.press('Enter');
    await page.waitForFunction((c) => document.getElementById('inp').value === c, rowCode, { timeout: 30000 });
    await page.evaluate(() => showInTree('8517130000'));
    await page.waitForSelector('#pageTree .ett-row[role="button"]', { timeout: 30000 });
    await audit('группа в классификаторе');
    await page.evaluate(() => [...document.querySelectorAll('#pageTree [role="button"]')].find((e) => /Классификатор ТН ВЭД/.test(e.textContent)).focus());
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#pageTree .ett-row'), null, { timeout: 30000 });   // корень дерева: списка кодов нет
    await audit('корень классификатора');
    await page.evaluate(() => renderTreeChapter('85', false, null));
    await page.waitForSelector('#pageTree .ett-row[role="button"]', { timeout: 30000 });
    const treeCode = await codeOfRow('#pageTree .ett-row');
    await page.evaluate(() => document.querySelector('#pageTree .ett-row').focus());
    await page.keyboard.press('Enter');
    await page.waitForFunction((c) => document.getElementById('inp').value === c, treeCode, { timeout: 30000 });

    // 5. Калькулятор: варианты кода из списка выбираются с клавиатуры.
    await page.evaluate(() => { setPage('search'); setSearchMode('calc'); });
    await search('8517', false);   // в калькуляторе ответ идёт в #calcResult, data-rq у #result не меняется
    await page.waitForSelector('#calcResult .calc-pick[role="button"]', { timeout: 30000 });
    await audit('варианты кода в калькуляторе');
    const pick = await page.evaluate(() => /selectCalcCode\('(\d+)'\)/.exec(document.querySelector('#calcResult .calc-pick').getAttribute('onclick'))[1]);
    await page.evaluate(() => document.querySelector('#calcResult .calc-pick').focus());
    await page.keyboard.press('Enter');
    await page.waitForFunction((c) => calcSelectedCode === c, pick, { timeout: 30000 });
    // 6. Уменьшение движения (prefers-reduced-motion): переходы и анимации мгновенные, прокрутка не плавная; без запроса — плавная.
    assert.equal(await page.evaluate(() => smoothOrAuto()), 'smooth');
    const rmCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const rm = await rmCtx.newPage();
    await rm.goto('http://127.0.0.1:' + PORT + '/');
    await rm.locator('#authEmail').waitFor({ state: 'visible' });
    await rm.locator('#authEmail').fill(user.email);
    await rm.locator('#authPassword').fill('user-password');
    await rm.locator('#authSubmit').click();
    await rm.locator('#appWrap').waitFor({ state: 'visible' });
    await rm.fill('#inp', '8517130000');
    await rm.keyboard.press('Enter');
    await rm.waitForSelector('#result .card.collapsible', { timeout: 30000 });
    assert.equal(await rm.evaluate(() => smoothOrAuto()), 'auto', 'при prefers-reduced-motion прокрутка мгновенная');
    const durs = await rm.evaluate(() => ["#result .card-more", "#result .card-chevron", "#expandAllBtn"].map((s) => parseFloat(getComputedStyle(document.querySelector(s)).transitionDuration)));
    assert.ok(durs.every((d) => d < 0.001), 'переходы сведены к мгновенным: ' + durs.join(', '));
    const adur = await rm.evaluate(() => { const e = document.createElement('div'); e.className = 'modal-backdrop'; document.body.appendChild(e); const d = parseFloat(getComputedStyle(e).animationDuration); e.remove(); return d; });
    assert.ok(adur < 0.001, 'анимация окна сведена к мгновенной: ' + adur);
    await rmCtx.close();
    checked.push('уменьшение движения');
  } finally {
    await browser.close();
    server.close();
  }
  console.log('PASS: клавиатура и уменьшение движения — Tab доходит до строк списка, Enter и пробел открывают код, карточки и секцию «справочно» (aria-expanded согласован), дерево и калькулятор; проверено видов без кликабельных div/span: ' + checked.length + ' (' + checked.join(', ') + ')');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
