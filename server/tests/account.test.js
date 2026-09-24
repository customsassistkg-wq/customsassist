// node server/tests/account.test.js
// Меню аккаунта и смена пароля (routes/auth.js, /change-password) на настоящем src/index.js с
// подменённой базой: без входа — 401; нужен верный текущий пароль; новый — от 8 знаков и не равен
// текущему; после смены другие сессии получают «пароль изменён», текущая остаётся; лимит попыток;
// dashUrl — только администратору. С PLAYWRIGHT_MODULE — браузер: пункты меню администратора и
// пользователя, счётчик обращений, таблица пользователей в одну строку, меню «⋯», поиск, телефон.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

// Порт известен заранее: браузер шлёт Origin своего адреса, а список origin читается при загрузке.
const PORT = 40000 + Math.floor(Math.random() * 2000);
process.env.APP_ORIGIN = 'https://test.local,http://127.0.0.1:' + PORT;
process.env.SESSION_SECRET = 'local-check-only';
process.env.DASH_ORIGIN = 'https://dash.test.local';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;

const mk = (id, email, role, pw) => ({ id, email, password_hash: bcrypt.hashSync(pw, 4), role, active: true, email_verified_at: new Date(),
  subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: '2026-09-18' });
const user = mk('22222222-2222-4222-8222-222222222222', 'user@test.local', 'user', 'old-password');
const admin = mk('11111111-1111-4111-8111-111111111111', 'admin@test.local', 'admin', 'admin-password');
const users = [user, admin];
const ended = [];

require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => {
  if (/from users order by created_at asc/.test(sql)) return { rows: users.map((u) => ({ ...u, created_at: new Date('2026-09-01'), last_login_at: new Date(), online: u.id === admin.id })) };
  if (/as new,/.test(sql) && /from inbox/.test(sql)) return { rows: [{ new: 3, open: 0, total: 3, month: 3 }] };
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: users.filter((u) => u.id === args[0] || u.email === args[0]).map((u) => ({ ...u })) };
  if (/^update users set password_hash = \$1 where id = \$2/.test(sql)) { users.find((u) => u.id === args[1]).password_hash = args[0]; return { rows: [] }; }
  if (/^update session\s+set sess/.test(sql)) { ended.push(args); return { rows: [] }; }
  return { rows: [] };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

const app = require('../src/index');

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const hdr = { 'content-type': 'application/json', origin: 'https://test.local' };
  const login = async (email, password) => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: hdr, body: JSON.stringify({ email, password }) });
    return { status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const change = (cookie, body) => fetch(base + '/api/auth/change-password', { method: 'POST', headers: { ...hdr, cookie }, body: JSON.stringify(body) });
  try {
    assert.equal((await change('', { current: 'x', password: 'new-password' })).status, 401);

    const l = await login(user.email, 'old-password');
    assert.equal(l.status, 200);
    assert.equal(l.body.dashUrl, null, 'обычному пользователю ссылки на дашборд нет');
    const c = l.cookie;
    let r = await change(c, { current: 'wrong-password', password: 'new-password' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'wrong current password');
    assert.equal((await change(c, { current: 'old-password', password: 'short' })).status, 400);
    assert.equal((await change(c, { current: 'old-password' })).status, 400);
    r = await change(c, { current: 'old-password', password: 'old-password' });
    assert.equal((await r.json()).error, 'same password');
    console.log('PASS: без входа 401; неверный текущий 403; короткий, пустой и тот же пароль — 400');

    r = await change(c, { current: 'old-password', password: 'new-password' });
    assert.equal(r.status, 200);
    assert.ok(await bcrypt.compare('new-password', user.password_hash));
    assert.deepEqual(ended.at(-1), [user.id, 'password_reset'], 'остальные сессии завершены');
    assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie: c } })).status, 200, 'текущая сессия осталась');
    assert.equal((await login(user.email, 'old-password')).status, 401);
    assert.equal((await login(user.email, 'new-password')).status, 200);
    console.log('PASS: смена — новый хэш, другие сессии завершены, эта осталась; вход только с новым паролем');

    const a = await login(admin.email, 'admin-password');
    assert.equal(a.body.dashUrl, 'https://dash.test.local');
    const me = await (await fetch(base + '/api/auth/me', { headers: { cookie: a.cookie } })).json();
    assert.equal(me.dashUrl, 'https://dash.test.local');
    console.log('PASS: dashUrl — только администратору, во входе и в /me');

    // Лимит: 10 попыток в час на учётную запись (здесь уже 5 с этой сессией до входа заново — считаем все).
    const c2 = (await login(user.email, 'new-password')).cookie;
    let last;
    for (let i = 0; i < 10; i++) last = await change(c2, { current: 'wrong-password', password: 'another-password' });
    assert.equal(last.status, 429);
    console.log('PASS: перебор текущего пароля упирается в лимит (429)');

    if (!process.env.PLAYWRIGHT_MODULE) { console.log('SKIP: браузерная часть — нужен PLAYWRIGHT_MODULE'); return; }
    const browser = await require(process.env.PLAYWRIGHT_MODULE).chromium.launch({ channel: 'msedge', headless: true });
    try {
      const open = async (email, password, width) => {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/');
        await page.fill('#authEmail', email);
        await page.fill('#authPassword', password);
        await page.click('#authSubmit');
        await page.waitForSelector('#userBar', { state: 'visible' });
        return { ctx, page, errors };
      };
      const items = (page) => page.$$eval('#accMenu .acc-sec, #accMenu .acc-item', (els) => els.map((e) => e.classList.contains('acc-sec') ? e.textContent
        : e.querySelector('.acc-lbl').textContent + (e.querySelector('.acc-badge:not([hidden])') ? e.querySelector('.acc-badge').textContent : '')));

      // Администратор: разделы админки, счётчик новых обращений, ссылка на дашборд.
      let { ctx, page, errors } = await open(admin.email, 'admin-password', 1280);
      await page.click('#accMenuBtn');
      await page.waitForFunction(() => !document.getElementById('accMailBadge').hidden);
      assert.deepEqual(await items(page), ['Администрирование', 'Пользователи', 'Журнал AI-ассистента', 'Оплаты и расходы', 'Обращения3', 'Дашборд',
        'Аккаунт', 'Сменить пароль', 'Написать в поддержку', 'Выйти']);
      assert.equal(await page.getAttribute('#accMenu a[href="https://dash.test.local"]', 'target'), '_blank');
      await page.keyboard.press('Escape');
      assert.equal(await page.isVisible('#accMenu'), false, 'Escape закрывает меню');
      // Пользователи: строка в одну линию, без горизонтальной прокрутки, действия — меню «⋯».
      await page.click('#accMenuBtn');
      await page.click('#adminLinkBtn');
      await page.waitForSelector('.au-table');
      const heights = await page.$$eval('.au-table .admin-tr', (rs) => rs.map((r) => r.getBoundingClientRect().height));
      assert.ok(heights.every((h) => h < 70), 'строки в одну линию: ' + heights.join(','));
      assert.equal(await page.$eval('.admin-table-wrap', (w) => w.scrollWidth - w.clientWidth), 0);
      await page.locator('.admin-tr', { hasText: user.email }).locator('.au-more').click();
      assert.deepEqual(await page.$$eval('.au-menu .au-mi', (b) => b.map((x) => x.textContent)),
        ['Срок подписки…', 'Записать оплату…', 'Сделать администратором', 'Отключить доступ', 'Удалить…']);
      await page.click('.au-menu .au-mi[data-act="sub"]');
      await page.waitForSelector('#activeModal');
      await page.evaluate(() => closeModal());
      await page.fill('#adminSearch', 'admin@');
      assert.deepEqual(await page.$$eval('.au-table .admin-tr:not([hidden]) .au-email', (e) => e.map((x) => x.textContent)), [admin.email]);
      await page.fill('#adminSearch', 'нет-такого');
      assert.equal(await page.isVisible('#adminEmpty'), true);
      // Выход убирает меню «⋯» с адресом из DOM.
      await page.fill('#adminSearch', '');
      await page.locator('.admin-tr').first().locator('.au-more').click();
      await page.evaluate(() => doLogout());
      await page.waitForSelector('#authScreen', { state: 'visible' });
      assert.equal(await page.$('.au-menu'), null);
      assert.deepEqual(errors, []);
      await ctx.close();
      console.log('PASS: браузер — меню администратора (5 пунктов, счётчик 3, дашборд), таблица в одну строку, «⋯», поиск, выход чистит меню');

      // Пользователь: без раздела администрирования, смена пароля из меню; телефон — карточки.
      ({ ctx, page, errors } = await open(user.email, 'new-password', 390));
      await page.click('#accMenuBtn');
      assert.deepEqual(await items(page), ['Аккаунт', 'AI-ассистент', 'Сменить пароль', 'Написать в поддержку', 'Выйти']);
      const menuBox = await page.$eval('#accMenu', (m) => { const r = m.getBoundingClientRect(); return [r.left, r.right, innerWidth]; });
      assert.ok(menuBox[0] >= 0 && menuBox[1] <= menuBox[2], 'меню помещается на 390: ' + menuBox.join(','));
      await page.click('#accPwdBtn');
      await page.fill('#cpCurrent', 'new-password');
      await page.fill('#cpNew', 'third-password');
      await page.fill('#cpNew2', 'third-passwort');
      await page.click('#cpSubmit');
      assert.equal(await page.textContent('#cpError'), 'Новые пароли не совпадают');
      assert.deepEqual(errors, []);
      await ctx.close();
      console.log('PASS: браузер — меню пользователя без админки, помещается на 390, форма пароля проверяет повтор');

      ({ ctx, page, errors } = await open(admin.email, 'admin-password', 390));
      await page.click('#accMenuBtn');
      await page.click('#adminLinkBtn');
      await page.waitForSelector('.au-table');
      assert.equal(await page.$eval('.au-table thead', (t) => getComputedStyle(t).display), 'none', 'на телефоне — карточки');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, 'страница не шире телефона: +' + over);
      // Смена пароля из меню — у администратора: лимит пользователя исчерпан проверкой 429 выше.
      await page.click('#accMenuBtn');
      await page.click('#accPwdBtn');
      await page.fill('#cpCurrent', 'admin-password');
      await page.fill('#cpNew', 'admin-password-2');
      await page.fill('#cpNew2', 'admin-password-2');
      await page.click('#cpSubmit');
      await page.waitForSelector('#cpForm .auth-ok');
      assert.ok(await bcrypt.compare('admin-password-2', admin.password_hash));
      assert.deepEqual(errors, []);
      await ctx.close();
      console.log('PASS: браузер — таблица пользователей на 390 карточками, без горизонтальной прокрутки; смена пароля из меню');
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
