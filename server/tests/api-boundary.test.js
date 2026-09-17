// node server/tests/api-boundary.test.js
// Граница API на настоящем src/index.js: проверка Origin, порядок разбора тела
// и проверки сессии, типы полей. База и хранилище сессий подменены, сети нет.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.APP_ORIGIN = 'https://test.local';
process.env.SESSION_SECRET = 'local-check-only';
process.env.AI_API_KEY = 'x';
delete process.env.NODE_ENV;

const user = { id: 'u1', email: 'user@test.local', password_hash: bcrypt.hashSync('right-password', 4), role: 'user',
  active: true, email_verified_at: new Date(), subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base' };
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => {
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: args[0] === user.id || args[0] === user.email ? [user] : [] };
  return { rows: [] };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

const app = require('../src/index');

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://test.local', ...headers }, body });
  const big = 'x'.repeat(2_000_000);
  try {
    // запрос, меняющий данные, без Origin — отказ (fail closed)
    let r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);

    // без входа большое тело помощника не разбирается: битый JSON на 2 МБ получает 401, а не ошибку разбора
    r = await post('/api/assistant', '{"messages":[' + big);
    assert.equal(r.status, 401);

    // нестроковый пароль — 400, а не 500 из bcrypt (длина массива 8 проходила проверку длины)
    r = await post('/api/auth/register', JSON.stringify({ email: 'new@test.local', password: ['1', '2', '3', '4', '5', '6', '7', '8'] }));
    assert.equal(r.status, 400);
    // остальному API — прежние 100 КБ, и слишком большое тело — 413, а не 500
    r = await post('/api/auth/register', JSON.stringify({ email: 'new@test.local', password: big }));
    assert.deepEqual([r.status, (await r.json()).error], [413, 'entity.too.large']);

    // после входа большое тело принимается и доходит до маршрута
    r = await post('/api/auth/login', JSON.stringify({ email: user.email, password: 'right-password' }));
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    r = await post('/api/assistant', JSON.stringify({ messages: [], pad: big }), { cookie });
    assert.deepEqual([r.status, (await r.json()).error], [400, 'bad_request']);
    r = await post('/api/assistant', '{"messages":[' + big, { cookie });
    assert.deepEqual([r.status, (await r.json()).error], [400, 'entity.parse.failed']);
    console.log('PASS: Origin обязателен; тело помощника разбирается только после входа; типы полей; 413 и 400 вместо 500');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
