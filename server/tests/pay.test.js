// node server/tests/pay.test.js
// Оплата подписки по QR через xPay (routes/pay.js, миграция 0016) на настоящем src/index.js с
// подменёнными базой и клиентом xPay, без сети: истёкшая подписка с верным паролем открывает только
// оплату; сумму считает сервер; повторный запрос отдаёт тот же QR; оплату засчитывает только
// COMPLETED с суммой заказа, один раз; webhook без Origin принимается, но сам ничего не засчитывает;
// чужой заказ не виден; без ключей xPay оплата выключена.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

// Порт известен заранее: браузер шлёт Origin своего адреса, а список origin читается при загрузке.
// Вне диапазона временных портов и Linux (32768–60999), и Windows (49152–65535): в нём порт иногда занят
// исходящим соединением, и тест падал с EADDRINUSE (01.10.2026, после браузерных тестов).
const PORT = 22000 + Math.floor(Math.random() * 1000);
process.env.APP_ORIGIN = 'https://test.local,http://127.0.0.1:' + PORT;
process.env.SESSION_SECRET = 'local-check-only';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;

const hash = bcrypt.hashSync('right-password', 4);
const mk = (id, email, sub) => ({ id, email, password_hash: hash, role: 'user', active: true, email_verified_at: new Date(),
  subscription_expires_at: sub, last_seen_at: new Date(), ai_plan: 'base', terms_version: '2026-09-18' });
const expired = mk('22222222-2222-4222-8222-222222222222', 'expired@test.local', '2026-01-01T23:59:59.999Z');
const active = mk('33333333-3333-4333-8333-333333333333', 'active@test.local', '2099-01-31T23:59:59.999Z');
const users = [expired, active];
const orders = [], payments = [];

require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, a = []) => {
  sql = sql.replace(/\s+/g, ' ').trim();
  if (/from users where email = \$1/.test(sql)) return { rows: users.filter((u) => u.email === a[0]) };
  if (/^update users set subscription_expires_at = \$2, ai_plan = \$3/.test(sql)) {
    const u = users.find((x) => x.id === a[0]); u.subscription_expires_at = a[1]; u.ai_plan = a[2]; return { rows: [] };
  }
  if (/from users where id = \$1/.test(sql)) return { rows: users.filter((u) => u.id === a[0]).map((u) => ({ ...u })) };
  if (/^insert into pay_orders/.test(sql)) {
    const o = { id: orders.length + 1, user_id: a[0], email: a[1], plan: a[2], months: a[3], amount: String(a[4]), status: 'waiting',
      qr_transaction_id: null, qr_code: null, qr_image: null, xpay_status: null, payable: null, payment_id: null, created_at: new Date(), paid_at: null };
    orders.push(o); return { rows: [{ ...o }] };
  }
  if (/^select id from pay_orders where user_id = \$1 order by created_at desc, id desc limit 1$/.test(sql)) {
    return { rows: orders.filter((o) => o.user_id === a[0]).sort((x, y) => y.created_at - x.created_at || y.id - x.id).slice(0, 1).map((o) => ({ id: o.id })) };
  }
  if (/^select \* from pay_orders where user_id = \$1/.test(sql)) return { rows: orders.filter((o) => o.user_id === a[0]).reverse().map((o) => ({ ...o })) };
  if (/from pay_orders where id = \$1/.test(sql)) return { rows: orders.filter((o) => o.id === a[0]).map((o) => ({ ...o })) };
  if (/^update pay_orders set qr_transaction_id/.test(sql)) {
    const o = orders.find((x) => x.id === a[0]); Object.assign(o, { qr_transaction_id: a[1], qr_code: a[2], qr_image: a[3] }); return { rows: [{ ...o }] };
  }
  if (/^update pay_orders set status = 'failed' where id = \$1$/.test(sql)) { orders.find((x) => x.id === a[0]).status = 'failed'; return { rows: [] }; }
  if (/^update pay_orders set xpay_status = \$2/.test(sql)) {
    const o = orders.find((x) => x.id === a[0] && x.status === 'waiting');
    if (!o) return { rows: [] };
    o.xpay_status = a[1];
    if (/status = 'paid'/.test(sql)) Object.assign(o, { status: 'paid', paid_at: new Date(), payable: a[2] });
    else if (/status = 'mismatch'/.test(sql)) o.status = 'mismatch';
    else if (a[2]) o.status = 'failed';
    return { rows: [{ ...o }] };
  }
  if (/^insert into payments/.test(sql)) { payments.push(a); return { rows: [{ id: payments.length }] }; }
  if (/^update pay_orders set payment_id/.test(sql)) { const o = orders.find((x) => x.id === a[0]); o.payment_id = a[1]; return { rows: [{ ...o }] }; }
  return { rows: [] };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

// xPay: QR создаётся с запомненными параметрами, статус задаёт тест.
const xp = { on: true, created: [], statusCalls: 0, status: { pay_status: 'WAITING' } };
require.cache[require.resolve('../src/services/xpay')] = { exports: {
  enabled: () => xp.on,
  createQr: async (p) => { xp.created.push(p); return { qr_transaction_id: 'TX' + p.orderId, qr_code: 'https://pay.xpay.kg#' + p.orderId, qr_image: 'https://image.xpay.kg/' + p.orderId + '.png', amount: p.amount }; },
  qrStatus: async () => { xp.statusCalls++; return xp.status; },
} };

// Настоящий PNG 1×1 — чтобы браузер его нарисовал.
const QR_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==';
// Картинки xPay: сеть не нужна — отдаём байты по адресу из заказа.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  const m = /^https:\/\/image\.xpay\.kg\/(\d+)\.png$/.exec(String(u));
  if (m && m[1] === '1') return Promise.resolve(new Response('PNG1', { headers: { 'content-type': 'image/png' } }));
  return m ? Promise.resolve(new Response(Buffer.from(QR_PNG, 'base64'), { headers: { 'content-type': 'image/png' } })) : realFetch(u, o);
};

const app = require('../src/index');
const pay = require('../src/routes/pay');
const { extendedUntil } = require('../src/routes/admin');

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const hdr = { 'content-type': 'application/json', origin: 'https://test.local' };
  const login = (email) => fetch(base + '/api/auth/login', { method: 'POST', headers: hdr, body: JSON.stringify({ email, password: 'right-password' }) });
  const call = (cookie, method, path, body) => fetch(base + path, { method, headers: { ...hdr, cookie }, body: body == null ? undefined : JSON.stringify(body) });
  const clearThrottle = () => pay._lastCheck.clear();
  try {
    // Без входа — закрыто.
    assert.equal((await fetch(base + '/api/pay/plans')).status, 401);

    // Истёкшая подписка, верный пароль: 403 с canPay и cookie сессии оплаты; остальной сайт — гость.
    let r = await login(expired.email);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'subscription_expired', canPay: true });
    const ec = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await call(ec, 'GET', '/api/auth/me')).status, 401);
    // Неверный пароль сессии оплаты не даёт.
    r = await fetch(base + '/api/auth/login', { method: 'POST', headers: hdr, body: JSON.stringify({ email: expired.email, password: 'wrong-password' }) });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
    console.log('PASS: истёкшая подписка — сессия только для оплаты, неверный пароль её не даёт');

    r = await call(ec, 'GET', '/api/pay/plans');
    assert.equal(r.status, 200);
    const plans = await r.json();
    assert.deepEqual(plans.months, [1, 3, 6, 12]);
    assert.deepEqual(plans.plans.map((p) => [p.key, p.price]), [['base', 490], ['pro', 990], ['max', 1990]]);

    // Неверные тариф и срок — 400; сумма из браузера не читается.
    assert.equal((await call(ec, 'POST', '/api/pay/create', { plan: 'gold', months: 1 })).status, 400);
    assert.equal((await call(ec, 'POST', '/api/pay/create', { plan: 'pro', months: 2 })).status, 400);
    r = await call(ec, 'POST', '/api/pay/create', { plan: 'pro', months: 3, amount: 1 });
    assert.equal(r.status, 201);
    const o1 = await r.json();
    assert.equal(o1.amount, 2970);
    assert.equal(o1.qr_code, 'https://pay.xpay.kg#1');
    assert.equal(xp.created[0].amount, 297000, 'в тыйынах');
    assert.equal(xp.created[0].callbackUrl, 'https://test.local/api/pay/callback?o=1');
    assert.equal(xp.created[0].checkUrl, 'https://test.local/api/pay/check?o=1');
    // Тот же тариф и срок — тот же заказ, второго QR нет.
    r = await call(ec, 'POST', '/api/pay/create', { plan: 'pro', months: 3 });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).id, o1.id);
    assert.equal(xp.created.length, 1);
    console.log('PASS: сумма по цене сервера в тыйынах, повтор — тот же QR, неверные поля — 400');

    // Пока не оплачено — ничего не засчитано.
    r = await call(ec, 'GET', '/api/pay/status/' + o1.id);
    assert.equal((await r.json()).status, 'waiting');
    // Webhook без Origin и без cookie принимается, но при WAITING ничего не меняет.
    clearThrottle();
    r = await fetch(base + '/api/pay/callback?o=' + o1.id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pay_status":"COMPLETED","amount":297000}' });
    assert.equal(r.status, 201, 'xPay ждёт 201, иначе повторяет сутки');
    assert.equal(payments.length, 0, 'тело webhook не засчитывает оплату');
    assert.equal((await fetch(base + '/api/pay/callback?o=abc', { method: 'POST' })).status, 400);
    console.log('PASS: webhook без Origin принят, его тело ничего не засчитывает');

    // Оплачено: webhook будит проверку, xPay говорит COMPLETED с суммой заказа.
    xp.status = { pay_status: 'COMPLETED', amount: 297000, payable: 294030 };
    clearThrottle();
    await fetch(base + '/api/pay/callback?o=' + o1.id, { method: 'POST' });
    assert.equal(payments.length, 1);
    const want = extendedUntil('2026-01-01T23:59:59.999Z', 3);
    assert.equal(expired.subscription_expires_at, want + 'T23:59:59.999Z');
    assert.equal(expired.ai_plan, 'pro');
    const [uid, email, amount, plan, months, paidUntil, note] = payments[0];
    assert.deepEqual([uid, email, amount, plan, months, paidUntil], [expired.id, expired.email, '2970', 'pro', 3, want]);
    assert.match(note, /^xPay TX1, зачислено 2940\.30$/);
    // Повторы (webhook, опрос, сверка) второй раз не засчитывают.
    clearThrottle();
    await fetch(base + '/api/pay/callback?o=' + o1.id, { method: 'POST' });
    clearThrottle();
    r = await call(ec, 'GET', '/api/pay/status/' + o1.id);
    const st = await r.json();
    assert.equal(st.status, 'paid');
    assert.equal(st.paid_until, want);
    await pay.reconcile();
    assert.equal(payments.length, 1);
    console.log('PASS: COMPLETED с суммой заказа — одна запись оплаты, срок от сегодня + 3 мес., тариф Pro; повторы не засчитывают');

    // Действующая подписка: продление от её срока; чужой заказ не виден.
    r = await login(active.email);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).payEnabled, true);
    const ac = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await call(ac, 'GET', '/api/pay/status/' + o1.id)).status, 404);
    // Картинка QR — через наш сервер и только владельцу заказа.
    assert.equal((await call(ac, 'GET', '/api/pay/qr/' + o1.id)).status, 404);
    r = await call(ec, 'GET', '/api/pay/qr/' + o1.id);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(await r.text(), 'PNG1');
    r = await call(ac, 'POST', '/api/pay/create', { plan: 'base', months: 1 });
    const o2 = await r.json();
    assert.equal(o2.amount, 490);
    // Оплачено другой суммой — не засчитывается, заказ помечен.
    xp.status = { pay_status: 'COMPLETED', amount: 100, payable: 99 };
    clearThrottle();
    r = await call(ac, 'GET', '/api/pay/status/' + o2.id);
    assert.equal((await r.json()).status, 'mismatch');
    assert.equal(payments.length, 1);
    assert.equal(active.subscription_expires_at, '2099-01-31T23:59:59.999Z');
    console.log('PASS: другая сумма — не засчитана (mismatch), срок не тронут; чужой заказ — 404');

    // Новый заказ, оплата верной суммой — продление от действующего срока, конец месяца держится.
    r = await call(ac, 'POST', '/api/pay/create', { plan: 'max', months: 1 });
    const o3 = await r.json();
    xp.status = { pay_status: 'COMPLETED', amount: 199000, payable: 197010 };
    clearThrottle();
    r = await call(ac, 'GET', '/api/pay/status/' + o3.id);
    assert.equal((await r.json()).status, 'paid');
    assert.equal(active.subscription_expires_at, '2099-02-28T23:59:59.999Z');
    assert.equal(active.ai_plan, 'max');
    // Отмена у xPay — заказ закрыт как failed.
    r = await call(ac, 'POST', '/api/pay/create', { plan: 'base', months: 12 });
    const o4 = await r.json();
    assert.equal(o4.amount, 5880);
    xp.status = { pay_status: 'CANCELED' };
    clearThrottle();
    r = await call(ac, 'GET', '/api/pay/status/' + o4.id);
    assert.equal((await r.json()).status, 'failed');
    console.log('PASS: продление от действующего срока (31.01 → 28.02), тариф Max; отмена — failed');

    // Частые проверки одного заказа — не чаще раза в 2 с.
    r = await call(ac, 'POST', '/api/pay/create', { plan: 'pro', months: 1 });
    const o5 = await r.json();
    xp.status = { pay_status: 'WAITING' };
    clearThrottle();
    const before = xp.statusCalls;
    for (let i = 0; i < 5; i++) await fetch(base + '/api/pay/callback?o=' + o5.id, { method: 'POST' });
    assert.equal(xp.statusCalls - before, 1);
    console.log('PASS: webhook-флуд — один запрос статуса к xPay');

    // check_url: xPay пускает платёж только после 201. Можно — последний заказ пользователя, ждущий
    // оплаты, не старше часа; нельзя — старый QR того же человека, оплаченный, отменённый, просроченный.
    const check = (id, method = 'POST') => fetch(base + '/api/pay/check?o=' + id, { method });
    assert.equal((await check(o5.id)).status, 201);
    assert.equal((await check(o5.id, 'GET')).status, 201);
    assert.equal((await check(o4.id)).status, 409, 'отменённый');
    assert.equal((await check(o3.id)).status, 409, 'уже оплачен');
    assert.equal((await check(999)).status, 409, 'нет такого');
    assert.equal((await check('abc')).status, 400);
    r = await call(ac, 'POST', '/api/pay/create', { plan: 'max', months: 3 });
    const o6 = await r.json();
    assert.equal((await check(o5.id)).status, 409, 'после нового заказа старый QR не оплатить');
    assert.equal((await check(o6.id)).status, 201);
    orders.find((o) => o.id === o6.id).created_at = new Date(Date.now() - 61 * 60e3);
    assert.equal((await check(o6.id)).status, 409, 'старше часа');
    console.log('PASS: check_url — платить можно только последний заказ не старше часа; старый, оплаченный, отменённый — 409');

    // Без ключей xPay: истёкший вход — прежний отказ без сессии, маршруты оплаты — 503.
    xp.on = false;
    users.push(mk('44444444-4444-4444-8444-444444444444', 'late@test.local', '2026-01-01T23:59:59.999Z'));
    r = await login('late@test.local');
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'subscription_expired' });
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal((await call(ac, 'GET', '/api/pay/plans')).status, 503);
    assert.equal((await call(ac, 'POST', '/api/pay/create', { plan: 'pro', months: 1 })).status, 503);
    console.log('PASS: без ключей xPay оплата выключена, вход с истёкшей подпиской — как раньше');

    // Браузер: окно оплаты — код страницы, без checker.js (истёкшая подписка), и из меню аккаунта.
    if (!process.env.PLAYWRIGHT_MODULE) {
      console.log('SKIP: браузерная часть — нужен PLAYWRIGHT_MODULE');
      return;
    }
    xp.on = true;
    const browser = await require('./browser').launch();
    const shots = process.env.PAY_SHOTS_DIR;
    try {
      users.push(mk('55555555-5555-4555-8555-555555555555', 'guest-pay@test.local', '2026-01-01T23:59:59.999Z'));
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/');
      await page.fill('#authEmail', 'guest-pay@test.local');
      await page.fill('#authPassword', 'right-password');
      await page.click('#authSubmit');
      await page.waitForSelector('#authPayBtn', { state: 'visible' });
      assert.match(await page.textContent('#authError'), /Оплатите продление/);
      assert.equal(await page.evaluate(() => typeof window.engine), 'undefined', 'checker.js не загружен');
      await page.click('#authPayBtn');
      await page.waitForSelector('#payForm', { state: 'visible' });
      assert.equal(await page.locator('#payPlanSel option').count(), 3);
      assert.equal(await page.textContent('#payTotal'), 'К оплате: 490 сом');
      await page.selectOption('#payMonthsSel', '3');
      assert.equal((await page.textContent('#payTotal')).replace(/\s/g, ' '), 'К оплате: 1 470 сом');
      if (shots) await page.screenshot({ path: shots + '/pay-form-1280.png' });
      xp.status = { pay_status: 'WAITING' };
      await page.click('#payGoBtn');
      await page.waitForSelector('#payQr', { state: 'visible' });
      await page.waitForFunction(() => document.getElementById('payQrImg').naturalWidth > 0);
      assert.match(await page.getAttribute('#payQrLink', 'href'), /^https:\/\/pay\.xpay\.kg#\d+$/);
      if (shots) await page.screenshot({ path: shots + '/pay-qr-1280.png' });
      // xPay: оплачено — окно само закрывается, экран входа говорит «оплата получена».
      const oid = orders[orders.length - 1].id;
      xp.status = { pay_status: 'COMPLETED', amount: 147000, payable: 145530 };
      await page.waitForSelector('#authInfo', { state: 'visible', timeout: 15000 });
      assert.match(await page.textContent('#authInfo'), /Оплата получена, подписка продлена до \d\d\.\d\d\.\d{4}\. Нажмите «Войти»\./);
      assert.equal(orders.find((o) => o.id === oid).status, 'paid');
      assert.equal(await page.isVisible('#payGate'), false);
      // Пароль остался в поле: «Войти» — и приложение открыто.
      await page.click('#authSubmit');
      await page.waitForSelector('#userBar', { state: 'visible', timeout: 15000 });
      assert.deepEqual(errors, []);
      console.log('PASS: браузер — истёкшая подписка: кнопка на экране входа, тариф и срок, QR через свой сервер, оплата, вход');

      // Меню аккаунта: «Продлить подписку»; выход закрывает окно.
      await page.click('#accMenuBtn');
      await page.click('#accPayBtn');
      await page.waitForSelector('#payForm', { state: 'visible' });
      await page.setViewportSize({ width: 390, height: 844 });
      if (shots) await page.screenshot({ path: shots + '/pay-form-390.png' });
      const overflow = await page.evaluate(() => document.querySelector('#payGate .terms-box').scrollWidth - document.querySelector('#payGate .terms-box').clientWidth);
      assert.ok(overflow <= 0, 'окно не шире экрана телефона: ' + overflow);
      await page.evaluate(() => doLogout());
      await page.waitForSelector('#authScreen', { state: 'visible' });
      assert.equal(await page.isVisible('#payGate'), false);
      assert.deepEqual(errors, []);
      console.log('PASS: браузер — «Продлить подписку» в меню, 390 px без переполнения, выход закрывает окно');
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
