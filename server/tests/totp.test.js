// node server/tests/totp.test.js  (браузерная часть — с PLAYWRIGHT_MODULE)
// Второй фактор входа администраторов (01.10.2026): TOTP по RFC 6238 (эталонные коды), секрет в базе зашифрован, коды
// восстановления — хеши и одноразовые, повтор кода не принимается. На настоящем src/index.js с подменённой базой:
// настройка — только администратору; включение первым кодом; вход без кода — totp_required и без сессии; неверный код —
// totp_invalid и неудачная попытка (лимит); код восстановления — один раз; выключение — пароль и код; /me и ответ входа
// говорят totpEnabled. Браузер: включение из меню аккаунта (QR, ключ, коды восстановления), вход с полем кода.
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const PORT = 24000 + Math.floor(Math.random() * 1000);
process.env.APP_ORIGIN = 'https://test.local,http://127.0.0.1:' + PORT;
process.env.SESSION_SECRET = 'local-check-only';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;

const totp = require('../src/services/totp');

// ── TOTP и хранение ──
{
  const key = Buffer.from('12345678901234567890');
  for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(totp.hotp(key, Math.floor(t / 30), 8), code, `RFC 6238, T=${t}`);
    assert.equal(totp.hotp(key, Math.floor(t / 30)), code.slice(-6));
  }
  assert.equal(totp.base32Encode(key), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.ok(totp.base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq').equals(key), 'ключ вводят с пробелами и строчными');
  const now = 1_800_000_000_000, s = totp.stepAt(now);
  const at = (step) => totp.hotp(key, step);
  assert.equal(totp.verify(key, at(s), { now }), s);
  assert.equal(totp.verify(key, at(s - 1), { now }), s - 1, 'шаг назад — часы телефона отстают');
  assert.equal(totp.verify(key, at(s + 1), { now }), s + 1);
  assert.equal(totp.verify(key, at(s - 2), { now }), null, 'два шага — уже нет');
  assert.equal(totp.verify(key, at(s), { now, lastStep: s }), null, 'тот же код второй раз — нет');
  assert.equal(totp.verify(key, at(s).slice(0, 3) + ' ' + at(s).slice(3), { now }), s, 'код с пробелом');
  for (const bad of ['', '12345', '1234567', 'abcdef', null, 123456]) assert.equal(totp.verify(key, bad, { now }), typeof bad === 'number' ? totp.verify(key, String(bad), { now }) : null);
  const sealed = totp.seal(key);
  assert.match(sealed, /^v1:[A-Za-z0-9+/=]+$/);
  assert.ok(!sealed.includes(totp.base32Encode(key)));
  assert.ok(totp.unseal(sealed).equals(key));
  const tampered = 'v1:' + Buffer.from(Buffer.from(sealed.slice(3), 'base64').map((b, i) => (i === 40 ? b ^ 1 : b))).toString('base64');
  assert.throws(() => totp.unseal(tampered), 'испорченный шифротекст не расшифровывается');
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'другой-ключ';
  assert.throws(() => totp.unseal(sealed), 'без ключа сервера секрет не открыть');
  process.env.SESSION_SECRET = saved;
  const codes = totp.newRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.ok(codes.every((c) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(c)));
  assert.equal(new Set(codes).size, 8);
  const hashes = codes.map(totp.hashRecovery);
  assert.equal(totp.matchRecovery(hashes, codes[3].toLowerCase().replace('-', ' ')), 3, 'регистр и разделитель не важны');
  assert.equal(totp.matchRecovery(hashes, 'AAAA-AAAA'), -1);
  assert.equal(totp.matchRecovery(null, codes[0]), -1);
  const qr = totp.qrDataUrl(totp.otpauthUri(key, 'admin@test.local'));
  assert.match(qr, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(qr.split(',')[1], 'base64').toString(), /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(totp.otpauthUri(key, 'admin@test.local'), /^otpauth:\/\/totp\/Customs%20Assist%20KG:admin%40test\.local\?secret=GEZDGNBV.+&issuer=Customs%20Assist%20KG&algorithm=SHA1&digits=6&period=30$/);
  console.log('PASS: TOTP — эталоны RFC 6238, окно ±1 шаг, повтор отклонён; секрет зашифрован ключом сервера; коды восстановления — хеши; QR — SVG');
}

// ── База и маршруты ──
const mk = (id, email, role, pw, extra = {}) => ({ id, email, password_hash: bcrypt.hashSync(pw, 4), role, active: true, email_verified_at: new Date(),
  subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: require('./terms-version'),
  totp_secret: null, totp_enabled_at: null, totp_last_step: null, totp_recovery: null, ...extra });
const admin = mk('11111111-1111-4111-8111-111111111111', 'admin@test.local', 'admin', 'admin-password');
const user = mk('22222222-2222-4222-8222-222222222222', 'user@test.local', 'user', 'user-password');
// второй администратор — со вторым фактором заранее: на нём проверяется лимит неверных кодов
const key2 = totp.newSecret();
const admin2 = mk('33333333-3333-4333-8333-333333333333', 'admin2@test.local', 'admin', 'admin2-password',
  { totp_secret: totp.seal(key2), totp_enabled_at: new Date(), totp_recovery: [] });
const users = [admin, user, admin2];
const audit = [];
const find = (id) => users.find((u) => u.id === id);
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, a = []) => {
  if (/from users where (id|email) = \$1/.test(sql)) return { rows: users.filter((u) => u.id === a[0] || u.email === a[0]).map((u) => ({ ...u, totp_recovery: u.totp_recovery && [...u.totp_recovery] })) };
  if (/^update users set totp_last_step = \$1 where id = \$2 and \(totp_last_step is null or totp_last_step < \$1\)/.test(sql)) {
    const u = find(a[1]);
    if (u.totp_last_step != null && u.totp_last_step >= a[0]) return { rowCount: 0, rows: [] };
    u.totp_last_step = a[0];
    return { rowCount: 1, rows: [] };
  }
  if (/^update users set totp_recovery = \$1 where id = \$2 and totp_recovery @> \$3/.test(sql)) {
    const u = find(a[1]), need = JSON.parse(a[2])[0];
    if (!(u.totp_recovery || []).includes(need)) return { rowCount: 0, rows: [] };
    u.totp_recovery = JSON.parse(a[0]);
    return { rowCount: 1, rows: [] };
  }
  if (/^update users set totp_secret = \$1, totp_enabled_at = now\(\), totp_last_step = \$2, totp_recovery = \$3 where id = \$4/.test(sql)) {
    Object.assign(find(a[3]), { totp_secret: a[0], totp_enabled_at: new Date(), totp_last_step: a[1], totp_recovery: JSON.parse(a[2]) });
    return { rowCount: 1, rows: [] };
  }
  if (/^update users set totp_secret = null, totp_enabled_at = null, totp_last_step = null, totp_recovery = null where id = \$1/.test(sql)) {
    Object.assign(find(a[0]), { totp_secret: null, totp_enabled_at: null, totp_last_step: null, totp_recovery: null });
    return { rowCount: 1, rows: [] };
  }
  if (/insert into admin_audit_log/.test(sql)) { audit.push([a[1], JSON.parse(a[3])]); return { rows: [] }; }
  return { rows: [], rowCount: 0 };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };
const telegram = require('../src/services/telegram');
const notes = [];
telegram.notify = (html) => notes.push(html);
const app = require('../src/index');

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + PORT;
  let ipN = 0; // вход ограничен 10 попытками с адреса за 15 минут — каждому запросу свой адрес
  const login = async (email, password, extra = {}) => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, ...extra }),
      headers: { 'content-type': 'application/json', origin: 'https://test.local', 'x-forwarded-for': '10.1.0.' + (++ipN % 250) } });
    return { status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const post = async (path, cookie, body = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://test.local', cookie }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const me = async (cookie) => (await fetch(base + '/api/auth/me', { headers: { cookie } })).json();
  const codeAt = (k, offsetSteps = 0) => totp.hotp(k, totp.stepAt(Date.now()) + offsetSteps);
  let browser;
  try {
    // настройка — только администратору
    const u = await login(user.email, 'user-password');
    assert.equal(u.status, 200);
    assert.equal((await post('/api/auth/totp/setup', u.cookie)).status, 403);
    assert.equal((await post('/api/auth/totp/setup', '')).status, 401);
    const a1 = await login(admin.email, 'admin-password');
    assert.deepEqual([a1.status, a1.body.totpEnabled], [200, false]);
    assert.equal((await post('/api/auth/totp/enable', a1.cookie, { code: '123456' })).body.error, 'totp_setup_required', 'без настройки включить нельзя');
    const setup = await post('/api/auth/totp/setup', a1.cookie);
    assert.equal(setup.status, 200);
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.body.qr, /^data:image\/svg\+xml;base64,/);
    const k = totp.base32Decode(setup.body.secret);
    assert.equal((await post('/api/auth/totp/enable', a1.cookie, { code: codeAt(k, 5) })).body.error, 'totp_invalid');
    const enableCode = codeAt(k);
    const on = await post('/api/auth/totp/enable', a1.cookie, { code: enableCode });
    assert.equal(on.status, 200);
    assert.equal(on.body.recovery.length, 8);
    assert.match(admin.totp_secret, /^v1:/, 'в базе — шифротекст');
    assert.ok(!admin.totp_secret.includes(setup.body.secret), 'ключа открытым текстом в базе нет');
    assert.ok(totp.unseal(admin.totp_secret).equals(k));
    assert.equal(admin.totp_recovery.length, 8);
    assert.ok(admin.totp_recovery.every((h) => /^[0-9a-f]{64}$/.test(h)) && !admin.totp_recovery.includes(on.body.recovery[0]), 'коды восстановления — хеши');
    assert.equal((await me(a1.cookie)).totpEnabled, true, '/me говорит, что включён');
    assert.equal((await post('/api/auth/totp/setup', a1.cookie)).status, 409, 'повторная настройка — нет');
    assert.ok(audit.some(([act]) => act === 'totp_enabled'));
    assert.ok(notes.some((n) => /Второй фактор включён/.test(n) && n.includes(admin.email)));
    console.log('PASS: настройка — только администратору; включение первым кодом; секрет в базе зашифрован, коды восстановления — хеши; журнал и Telegram');

    // вход: без кода — totp_required и без сессии; тот же код, что при включении, — повтор; следующий — вход
    let r = await login(admin.email, 'admin-password');
    assert.deepEqual([r.status, r.body.error, r.cookie], [401, 'totp_required', ''], 'пароль верен, но без кода сессии нет');
    assert.equal((await login(admin.email, 'wrong-password', { totp: codeAt(k, 1) })).body.error, 'invalid credentials', 'с кодом, но неверным паролем — обычный отказ');
    r = await login(admin.email, 'admin-password', { totp: enableCode });
    assert.deepEqual([r.status, r.body.error], [401, 'totp_invalid'], 'код, которым включали, — уже использован');
    notes.length = 0;
    const loginCode = codeAt(k, 1);
    r = await login(admin.email, 'admin-password', { totp: loginCode });
    assert.deepEqual([r.status, r.body.totpEnabled], [200, true]);
    assert.ok(r.cookie);
    assert.match(notes.find((n) => /Вход администратора/.test(n)), /С кодом второго фактора/);
    assert.equal((await login(admin.email, 'admin-password', { totp: loginCode })).body.error, 'totp_invalid', 'тот же код второй раз — нет');
    // код восстановления — один раз
    notes.length = 0;
    r = await login(admin.email, 'admin-password', { recovery: on.body.recovery[2].toLowerCase() });
    assert.equal(r.status, 200);
    assert.equal(admin.totp_recovery.length, 7);
    assert.match(notes.find((n) => /Вход администратора/.test(n)), /По коду восстановления<\/b> — осталось кодов: 7/);
    assert.ok(audit.some(([act, d]) => act === 'totp_recovery_used' && d.left === 7));
    assert.equal((await login(admin.email, 'admin-password', { recovery: on.body.recovery[2] })).body.error, 'totp_invalid', 'тот же код восстановления второй раз — нет');
    // обычный пользователь второго фактора не видит
    assert.deepEqual([(await login(user.email, 'user-password')).status], [200]);
    console.log('PASS: вход — без кода totp_required без сессии; использованный код и повтор отклонены; верный — вход; код восстановления — один раз; пользователю не нужен');

    // выключение — пароль и код
    assert.equal((await post('/api/auth/totp/disable', a1.cookie, { password: 'wrong', totp: codeAt(k) })).status, 403);
    assert.equal((await post('/api/auth/totp/disable', a1.cookie, { password: 'admin-password' })).body.error, 'totp_required');
    assert.equal((await post('/api/auth/totp/disable', a1.cookie, { password: 'admin-password', totp: '000000' === codeAt(k) ? '111111' : '000000' })).body.error, 'totp_invalid');
    notes.length = 0;
    const off = await post('/api/auth/totp/disable', a1.cookie, { password: 'admin-password', recovery: on.body.recovery[5] });
    assert.equal(off.status, 200);
    assert.equal(admin.totp_secret, null);
    assert.ok(notes.some((n) => /Второй фактор выключен/.test(n)));
    r = await login(admin.email, 'admin-password');
    assert.deepEqual([r.status, r.body.totpEnabled], [200, false], 'после выключения — снова только пароль');
    console.log('PASS: выключение — неверный пароль 403, без кода и с неверным кодом — нет, пароль и код восстановления — да; потом вход по паролю');

    // неверный код — неудачная попытка входа и своя: подбор кода идёт с верным паролем, поэтому после 10 неверных
    // кодов за час — 429 и для верного кода; администраторам — одно сообщение «верный пароль, неверный код»
    notes.length = 0;
    const wrong2 = () => ('000000' === codeAt(key2) ? '111111' : '000000');
    let last;
    for (let i = 0; i < 10; i++) last = await login(admin2.email, 'admin2-password', { totp: wrong2() });
    assert.deepEqual([last.status, last.body.error], [401, 'totp_invalid']);
    assert.equal((await login(admin2.email, 'admin2-password', { totp: codeAt(key2) })).status, 429, 'после 10 неверных кодов верный до конца окна не открывает');
    const alerts = notes.filter((n) => /Верный пароль, неверный код второго фактора/.test(n));
    assert.equal(alerts.length, 1, 'сообщение — одно на окно, не на каждый код');
    assert.ok(alerts[0].includes(admin2.email) && /10\.1\.0\./.test(alerts[0]), 'в сообщении адрес учётной записи и IP');
    assert.equal((await login(admin2.email, 'wrong-password', { totp: codeAt(key2) })).body.error, 'invalid credentials', 'неверный пароль — по-прежнему обычный отказ');
    assert.ok(!notes.some((n) => /Вход администратора/.test(n)), 'входа не было');
    console.log('PASS: неверный код — неудачная попытка входа и своя: после 10 за час — 429 и для верного кода; одно сообщение администраторам');

    // ── Браузер ──
    if (!process.env.PLAYWRIGHT_MODULE) {
      console.log('SKIP: браузерная часть — нужен PLAYWRIGHT_MODULE');
      return;
    }
    browser = await require('./browser').launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const signIn = async (password) => {
      await page.locator('#authEmail').fill(admin.email);
      await page.locator('#authPassword').fill(password);
      await page.locator('#authSubmit').click();
    };
    await page.goto(base + '/');
    await signIn('admin-password');
    await page.locator('#appWrap').waitFor({ state: 'visible' });
    // включение из меню аккаунта
    await page.locator('#accMenuBtn').click();
    assert.equal(await page.locator('#accTotpState').innerText(), 'выключен');
    await page.locator('#accTotpBtn').click();
    await page.locator('#tfStart').click();
    await page.locator('#tfQr').waitFor({ state: 'visible' });
    assert.ok(await page.evaluate(async () => { const i = document.getElementById('tfQr'); if (!i.complete) await new Promise((r) => { i.onload = r; i.onerror = r; }); return i.naturalWidth > 0; }), 'QR-код показан');
    const shownKey = (await page.locator('#tfKey').innerText()).replace(/\s/g, '');
    assert.match(shownKey, /^[A-Z2-7]{32}$/);
    const bk = totp.base32Decode(shownKey);
    await page.locator('#tfCode').fill('000000' === codeAt(bk) ? '111111' : '000000');
    await page.locator('#tfOn').click();
    await page.waitForFunction(() => /Неверный код/.test(document.getElementById('tfError').textContent));
    await page.locator('#tfCode').fill(codeAt(bk));
    await page.locator('#tfOn').click();
    await page.locator('#tfRecovery').waitFor({ state: 'visible' });
    const rec = (await page.locator('#tfRecovery').innerText()).trim().split('\n');
    assert.equal(rec.length, 8);
    await page.locator('#tfDone').click();
    assert.equal(await page.locator('#accTotpState').innerText(), 'включён');
    // выход и вход: поле кода появляется, неверный код — ошибка, верный — вход
    await page.evaluate(() => doLogout());
    await page.locator('#authScreen').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#authTotpRow').isVisible(), false, 'до ответа сервера поля кода нет');
    await signIn('admin-password');
    await page.locator('#authTotpRow').waitFor({ state: 'visible' });
    assert.match(await page.locator('#authInfo').innerText(), /Введите код из приложения/);
    assert.equal(await page.locator('#appWrap').isVisible(), false);
    await page.locator('#authTotp').fill('000000' === codeAt(bk, 1) ? '111111' : '000000');
    await page.locator('#authTotp').press('Enter');
    await page.waitForFunction(() => /Неверный код/.test(document.getElementById('authError').textContent));
    await page.locator('#authTotp').fill(codeAt(bk, 1));
    await page.locator('#authSubmit').click();
    await page.locator('#appWrap').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#authTotpRow').isVisible(), false, 'после входа поле кода спрятано');
    // код восстановления в том же поле
    await page.evaluate(() => doLogout());
    await page.locator('#authScreen').waitFor({ state: 'visible' });
    await signIn('admin-password');
    await page.locator('#authTotpRow').waitFor({ state: 'visible' });
    await page.locator('#authTotp').fill(rec[0]);
    await page.locator('#authSubmit').click();
    await page.locator('#appWrap').waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
    console.log('PASS: браузер — включение из меню (QR, ключ, неверный и верный код, 8 кодов восстановления), вход с полем кода, неверный код, код восстановления');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
