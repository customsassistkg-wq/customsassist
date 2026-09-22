// node server/tests/payments.test.js
// Оплаты и постоянные расходы (routes/admin.js, миграция 0013) на настоящем src/index.js с
// подменённой базой: только администратору; запись оплаты продлевает подписку от текущего срока
// (если он не истёк) или от сегодня и ставит тариф; конец месяца не перескакивает; extend:false —
// только запись; проверка полей; удаление записи не трогает срок; статьи расходов.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.APP_ORIGIN = 'https://test.local';
process.env.SESSION_SECRET = 'local-check-only';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;

const hash = bcrypt.hashSync('right-password', 4);
const mk = (id, email, role, sub) => ({ id, email, password_hash: hash, role, active: true, email_verified_at: new Date(),
  subscription_expires_at: sub, last_seen_at: new Date(), ai_plan: 'base', terms_version: '2026-09-18' });
const admin = mk('11111111-1111-4111-8111-111111111111', 'admin@test.local', 'admin', null);
const user = mk('22222222-2222-4222-8222-222222222222', 'user@test.local', 'user', null);
const user2 = mk('33333333-3333-4333-8333-333333333333', 'paid@test.local', 'user', '2026-12-31T23:59:59.999Z');
const users = [admin, user, user2];
const byId = (id) => users.find((u) => u.id === id);
const audits = [], queries = [];
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => {
  queries.push(sql);
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: users.filter((u) => u.id === args[0] || u.email === args[0]) };
  if (/^update users set last_login_at/.test(sql)) return { rows: [] };
  if (/^update session/.test(sql)) return { rows: [] };
  if (/insert into admin_audit_log/.test(sql)) { audits.push([args[1], args[2], JSON.parse(args[3] || 'null')]); return { rows: [] }; }
  if (/^insert into payments/.test(sql)) return { rows: [{ id: 7, created_at: new Date() }] };
  if (/^update users set subscription_expires_at = \$2/.test(sql)) { const u = byId(args[0]); u.subscription_expires_at = args[1]; if (args[2]) u.ai_plan = args[2]; return { rows: [u] }; }
  if (/^update users set ai_plan = \$2/.test(sql)) { const u = byId(args[0]); u.ai_plan = args[1]; return { rows: [u] }; }
  if (/^delete from payments/.test(sql)) return { rows: args[0] === 7 ? [{ user_id: user.id, email: user.email, amount: '990.00', currency: 'KGS' }] : [] };
  if (/select p\.id, p\.user_id/.test(sql)) return { rows: [{ id: 7, email: user.email, amount: 990, currency: 'KGS' }] };
  if (/^insert into expenses/.test(sql)) return { rows: [{ id: 3, created_at: new Date() }] };
  if (/from expenses order by/.test(sql)) return { rows: [{ id: 3, name: 'Сервер', amount: 10, currency: 'USD', period: 'month', starts_on: '2026-09-01', ends_on: null, note: null }] };
  if (/^delete from expenses/.test(sql)) return { rows: args[0] === 3 ? [{ name: 'Сервер' }] : [] };
  return { rows: [] };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

const app = require('../src/index');
const { extendedUntil } = require('../src/routes/admin');

(async () => {
  // Дата продления: от сегодня, от будущего срока, конец месяца.
  assert.equal(extendedUntil(null, 1, new Date('2026-01-31T10:00:00Z')), '2026-02-28');
  assert.equal(extendedUntil('2026-12-31T23:59:59.999Z', 2, new Date('2026-09-22T00:00:00Z')), '2027-02-28');
  assert.equal(extendedUntil('2026-01-01T00:00:00Z', 1, new Date('2026-09-22T05:00:00Z')), '2026-10-22');
  assert.equal(extendedUntil('2026-10-15T23:59:59.999Z', 12, new Date('2026-09-22T05:00:00Z')), '2027-10-15');

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const hdr = { 'content-type': 'application/json', origin: 'https://test.local' };
  const login = async (email) => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: hdr, body: JSON.stringify({ email, password: 'right-password' }) });
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const call = (cookie, method, path, body) => fetch(base + path, { method, headers: { ...hdr, cookie }, body: body == null ? undefined : JSON.stringify(body) });
  try {
    // Без сессии и обычному пользователю — закрыто.
    assert.equal((await fetch(base + '/api/admin/payments', { method: 'POST', headers: hdr, body: '{}' })).status, 403);
    const uc = await login(user.email);
    assert.equal((await call(uc, 'POST', '/api/admin/payments', { user_id: user.id, amount: 1 })).status, 403);
    assert.equal((await call(uc, 'GET', '/api/admin/expenses')).status, 403);

    const ac = await login(admin.email);
    // Оплата Pro на месяц: продление от сегодня, тариф поставлен, запись в журнале.
    let r = await call(ac, 'POST', '/api/admin/payments', { user_id: user.id, amount: 990, plan: 'pro', months: 1, method: 'Mbank', note: 'чек 1' });
    assert.equal(r.status, 201);
    let j = await r.json();
    const expected = extendedUntil(null, 1);
    assert.equal(j.paid_until, expected);
    assert.equal(user.subscription_expires_at, expected + 'T23:59:59.999Z');
    assert.equal(user.ai_plan, 'pro');
    assert.deepEqual(audits[audits.length - 1], ['payment', user.id, { amount: 990, currency: 'KGS', plan: 'pro', months: 1, paid_until: expected, method: 'Mbank' }]);
    // От действующего срока, а не от сегодня; два месяца.
    r = await call(ac, 'POST', '/api/admin/payments', { user_id: user2.id, amount: 1980, plan: 'pro', months: 2 });
    j = await r.json();
    assert.deepEqual([r.status, j.paid_until, user2.subscription_expires_at], [201, '2027-02-28', '2027-02-28T23:59:59.999Z']);
    // extend:false — только запись: срок не трогается, тариф ставится отдельным запросом.
    const before = queries.length;
    r = await call(ac, 'POST', '/api/admin/payments', { user_id: user2.id, amount: 500, plan: 'max', months: 1, extend: false });
    j = await r.json();
    assert.deepEqual([r.status, j.paid_until, user2.subscription_expires_at, user2.ai_plan], [201, null, '2027-02-28T23:59:59.999Z', 'max']);
    assert.ok(!queries.slice(before).some((s) => /update users set subscription_expires_at/.test(s)), 'срок не менялся');
    // Администратору срок не ставится.
    r = await call(ac, 'POST', '/api/admin/payments', { user_id: admin.id, amount: 100 });
    assert.deepEqual([r.status, (await r.json()).paid_until, admin.subscription_expires_at], [201, null, null]);
    // Проверка полей.
    for (const [body, err] of [
      [{ user_id: 'x', amount: 1 }, 'invalid user id'],
      [{ user_id: user.id, amount: 0 }, 'invalid amount'],
      [{ user_id: user.id, amount: 'abc' }, 'invalid amount'],
      [{ user_id: user.id, amount: 1, months: 25 }, 'invalid months'],
      [{ user_id: user.id, amount: 1, months: 1.5 }, 'invalid months'],
      [{ user_id: user.id, amount: 1, plan: 'gold' }, 'invalid plan'],
      [{ user_id: user.id, amount: 1, currency: 'сом' }, 'invalid currency'],
    ]) {
      r = await call(ac, 'POST', '/api/admin/payments', body);
      assert.deepEqual([r.status, (await r.json()).error], [400, err], JSON.stringify(body));
    }
    r = await call(ac, 'POST', '/api/admin/payments', { user_id: '44444444-4444-4444-8444-444444444444', amount: 1 });
    assert.equal(r.status, 404);
    // Список и удаление записи (срок остаётся).
    r = await call(ac, 'GET', '/api/admin/payments?limit=10');
    assert.deepEqual([r.status, (await r.json()).length], [200, 1]);
    const subBefore = user.subscription_expires_at;
    r = await call(ac, 'DELETE', '/api/admin/payments/7');
    assert.deepEqual([r.status, user.subscription_expires_at, audits[audits.length - 1][0]], [200, subBefore, 'delete_payment']);
    assert.equal((await call(ac, 'DELETE', '/api/admin/payments/8')).status, 404);
    assert.equal((await call(ac, 'DELETE', '/api/admin/payments/abc')).status, 400);
    // Постоянные расходы.
    r = await call(ac, 'POST', '/api/admin/expenses', { name: 'Сервер', amount: 10, currency: 'usd', period: 'month' });
    assert.deepEqual([r.status, (await r.json()).id, audits[audits.length - 1][0]], [201, 3, 'expense_add']);
    for (const [body, err] of [
      [{ name: '', amount: 1 }, 'name required'],
      [{ name: 'x', amount: -1 }, 'invalid amount'],
      [{ name: 'x', amount: 1, period: 'week' }, 'invalid period'],
      [{ name: 'x', amount: 1, starts_on: '22.09.2026' }, 'invalid date'],
    ]) {
      r = await call(ac, 'POST', '/api/admin/expenses', body);
      assert.deepEqual([r.status, (await r.json()).error], [400, err], JSON.stringify(body));
    }
    r = await call(ac, 'GET', '/api/admin/expenses');
    assert.deepEqual([r.status, (await r.json())[0].name], [200, 'Сервер']);
    assert.equal((await call(ac, 'DELETE', '/api/admin/expenses/3')).status, 200);
    assert.equal((await call(ac, 'DELETE', '/api/admin/expenses/4')).status, 404);
    console.log('PASS: оплаты — только администратору; продление от срока или от сегодня, конец месяца, тариф, журнал; extend:false; поля; удаление записи не трогает срок; статьи расходов');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
