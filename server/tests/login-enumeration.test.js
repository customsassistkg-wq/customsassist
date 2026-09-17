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
  await login({ ip, body: { email, password }, session: { regenerate: (cb) => cb() } }, { status(n) { status = n; return this; }, json(b) { body = b; } }, (e) => { throw e; });
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

  // Перебор пароля к одному адресу с разных IP упирается в счётчик неудач на адрес:
  // после 20 неудач отказ получает даже верный пароль, другие адреса не затронуты,
  // и для несуществующего адреса ответ тот же — счётчик не выдаёт, есть ли адрес.
  for (let i = 0; i < 18; i++) assert.equal((await attempt('Known@x.kg', 'guess-' + i, '10.1.0.' + i)).status, 401);
  for (let i = 0; i < 20; i++) assert.equal((await attempt('ghost@x.kg', 'guess-' + i, '10.2.0.' + i)).status, 401);
  assert.equal((await attempt('known@x.kg', 'right-password', '10.3.0.1')).status, 200 /* 19 неудач с учётом первой проверки — ещё можно */);
  assert.equal((await attempt('known@x.kg', 'wrong-again', '10.3.0.2')).status, 401);
  assert.equal((await attempt('known@x.kg', 'right-password', '10.3.0.3')).status, 429);
  assert.equal((await attempt('ghost@x.kg', 'anything', '10.3.0.4')).status, 429);
  assert.equal((await attempt('off@x.kg', 'wrong', '10.3.0.5')).status, 401);
  assert.equal((await attempt(['known@x.kg'], 'right-password', '10.3.0.6')).status, 400);
  console.log('PASS: вход — 20 неудач на адрес с любых IP закрывают вход на час, одинаково для существующего и несуществующего адреса');
})().catch((e) => { console.error(e); process.exitCode = 1; });
