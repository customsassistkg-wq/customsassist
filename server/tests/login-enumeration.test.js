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
// Проверка дубля при регистрации сравнивает каноническую форму адреса (split_part в запросе).
const canonicalTaken = new Set(['known@x.kg', 'ivanpetrov@gmail.com']);
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => (/split_part/.test(sql)
  ? { rows: canonicalTaken.has(args[0]) ? [{}] : [] }
  : { rows: users[args && args[0]] ? [users[args[0]]] : [] }) } } };

const compared = [];
const realCompare = bcrypt.compare;
bcrypt.compare = (pw, h) => { compared.push(h); return realCompare(pw, h); };

const router = require('../src/routes/auth');
const login = router.stack.find((l) => l.route && l.route.path === '/login').route.stack[0].handle;

async function attempt(email, password, ip, turnstileToken) {
  let status = 200, body;
  const started = Date.now();
  await login({ ip, body: { email, password, turnstileToken }, session: { regenerate: (cb) => cb() } }, { status(n) { status = n; return this; }, json(b) { body = b; } }, (e) => { throw e; });
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
  // С настроенной капчей закрытый адрес не заперт наглухо: без токена — «нужна капча», с токеном
  // верный пароль входит; жёсткий порог (100 неудач) закрывает и этот путь.
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, action: 'login' }) });
  try {
    assert.deepEqual((await attempt('known@x.kg', 'right-password', '10.5.0.1')).body, { error: 'captcha_required' });
    assert.deepEqual((await attempt('ghost@x.kg', 'anything', '10.5.0.2')).body, { error: 'captcha_required' }, 'и для несуществующего адреса — тот же ответ');
    assert.equal((await attempt('known@x.kg', 'right-password', '10.5.0.3', 'token')).status, 200);
    for (let i = 0; i < 80; i++) await attempt('known@x.kg', 'guess', '10.6.' + (i >> 3) + '.' + i, 'token');
    assert.deepEqual((await attempt('known@x.kg', 'right-password', '10.5.0.4', 'token')).body, { error: 'too many attempts, try again later' });
  } finally {
    global.fetch = realFetch;
    delete process.env.TURNSTILE_SECRET_KEY;
  }
  console.log('PASS: вход — 20 неудач на адрес с любых IP закрывают вход на час, одинаково для существующего и несуществующего адреса; с капчей — вход по токену, жёсткий порог');

  // Один ящик — одна пробная учётная запись: «+метка», точки и googlemail у Gmail — тот же адрес.
  const c = router.canonicalEmail;
  assert.equal(c('Ivan.Petrov+trial2@GoogleMail.com'), 'ivanpetrov@gmail.com');
  assert.equal(c('i.van+x@mail.ru'), 'i.van@mail.ru', 'точки значимы везде, кроме Gmail');
  assert.equal(c('plain@x.kg'), 'plain@x.kg');
  const register = router.stack.find((l) => l.route && l.route.path === '/register').route.stack[0].handle;
  const signUp = async (email, ip) => {
    let status = 200, body;
    await register({ ip, body: { email, password: 'long-enough-1' } }, { status(n) { status = n; return this; }, json(b) { body = b; } }, (e) => { throw e; });
    return { status, body };
  };
  for (const [i, email] of ['known+2@x.kg', 'i.van.petrov@gmail.com', 'IvanPetrov+a@googlemail.com'].entries()) {
    assert.deepEqual(await signUp(email, '10.4.0.' + i), { status: 409, body: { error: 'email already exists' } });
  }
  console.log('PASS: регистрация — «+метка», точки Gmail и googlemail не дают второй учётной записи на тот же ящик');
})().catch((e) => { console.error(e); process.exitCode = 1; });
