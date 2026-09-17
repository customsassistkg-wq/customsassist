// node server/tests/login-enumeration.test.js
// Вход не выдаёт, есть ли адрес: неизвестный, отключённый и существующий с
// неверным паролем получают один ответ и одинаково проходят bcrypt.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const hash = bcrypt.hashSync('right-password', 12);
const users = {
  'known@x.kg': { id: 'u1', email: 'known@x.kg', password_hash: hash, role: 'user', active: true, email_verified_at: new Date() },
  'off@x.kg': { id: 'u2', email: 'off@x.kg', password_hash: hash, role: 'user', active: false, email_verified_at: new Date() },
};
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => ({ rows: users[args && args[0]] ? [users[args[0]]] : [] }) } } };

const compared = [];
const realCompare = bcrypt.compare;
bcrypt.compare = (pw, h) => { compared.push(h); return realCompare(pw, h); };

const router = require('../src/routes/auth');
const login = router.stack.find((l) => l.route && l.route.path === '/login').route.stack[0].handle;

async function attempt(email, password, ip) {
  let status = 200, body;
  const started = Date.now();
  await login({ ip, body: { email, password } }, { status(n) { status = n; return this; }, json(b) { body = b; } }, (e) => { throw e; });
  return { status, body, ms: Date.now() - started };
}

(async () => {
  const unknown = await attempt('nobody@x.kg', 'whatever-pass', '10.0.0.1');
  const disabled = await attempt('off@x.kg', 'right-password', '10.0.0.2');
  const wrong = await attempt('known@x.kg', 'wrong-password', '10.0.0.3');
  for (const r of [unknown, disabled, wrong]) assert.deepEqual([r.status, r.body], [401, { error: 'invalid credentials' }]);
  // каждый путь сравнил пароль с хешем той же стоимости
  assert.equal(compared.length, 3);
  for (const h of compared) assert.match(h, /^\$2[aby]\$12\$/);
  // и занял время bcrypt, а не мгновенный ответ
  assert.ok(unknown.ms > 20 && disabled.ms > 20, `unknown ${unknown.ms} ms, disabled ${disabled.ms} ms`);
  console.log('PASS: вход — неизвестный, отключённый и неверный пароль: один ответ, bcrypt на каждом пути');
})().catch((e) => { console.error(e); process.exitCode = 1; });
