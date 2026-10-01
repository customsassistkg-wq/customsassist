// node server/tests/engine.test.js
// База на сервере (/api/engine): доступ только вошедшему, только функции ENGINE_API,
// лимиты перебора и письмо администраторам; checker.js без base.js загружается, как в браузере.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

process.env.RESEND_API_KEY = 'test';
process.env.ENGINE_LIMITS = JSON.stringify({ perMinute: 30, perDay: 200, keysAlert: 5, keysLimit: 8 });
const mails = [];
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async () => ({ rows: [{ email: 'admin@example.test' }] }) } } };
const email = require('../src/services/email');
email.sendEmail = async (m) => { mails.push(m); };
const engine = require('../src/routes/engine');

// ── Браузерная копия: интерфейс без базы ──
{
  const code = fs.readFileSync(path.join(__dirname, '../private/checker.js'), 'utf8');
  const noop = () => {};
  const el = () => ({ addEventListener: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {},
    appendChild: noop, setAttribute: noop, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] });
  const calls = [];
  const sb = { console, setTimeout, clearTimeout, addEventListener: noop, localStorage: { getItem: () => null, setItem: noop },
    document: { getElementById: el, querySelector: el, querySelectorAll: () => [], createElement: el, addEventListener: noop, body: el() },
    apiFetch: async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { ok: true, status: 200, json: async () => ({ result: { html: '<b>x</b>', cards: false } }) }; } };
  sb.window = sb;
  vm.createContext(sb);
  new vm.Script(code).runInContext(sb);
  assert.equal(vm.runInContext('typeof ETT_DB', sb), 'undefined');
  assert.equal(vm.runInContext('typeof findBan', sb), 'undefined');
  assert.equal(vm.runInContext('typeof ENGINE_API', sb), 'undefined');
  (async () => {
    const r1 = await vm.runInContext("engine('renderHtml','8517130000')", sb);
    const r2 = await vm.runInContext("engine('renderHtml','8517130000')", sb);
    assert.equal(r1.html, '<b>x</b>');
    assert.equal(r2, r1);
    assert.deepEqual(calls, [['/api/engine', { fn: 'renderHtml', args: ['8517130000'] }]]); // повтор — из памяти страницы
    console.log('PASS: checker.js загружается без базы; engine() спрашивает /api/engine и помнит ответ');
  })().catch((e) => { console.error(e); process.exitCode = 1; });
}

// ── Что считается «разной позицией» ──
{
  const k = engine.keysOf;
  assert.deepEqual(k('renderHtml', ['8517']), ['h8517']);
  assert.deepEqual(k('renderHtml', ['8517 13 000 0']), ['h8517']);
  assert.deepEqual(k('codeBundle', [['8517130000', '8517120000', '0201100001']]), ['h8517', 'h8517', 'h0201']);
  assert.deepEqual(k('renderHtml', ['Смартфон']), ['tсмартфон']);
  assert.deepEqual(k('treeChapter', ['84', 50]), ['g84']);
  assert.deepEqual(k('renderHtml', ['85']), []);
  const u = { id: 'typing', email: 'u@example.test' };
  for (const q of ['с', 'см', 'сма', 'смар', 'смарт', 'смартфон']) assert.equal(engine.account(u, 'renderHtml', [q]), null);
  assert.equal(engine.usage.get('typing').keys.size, 1, 'набор слова по буквам — одна позиция');
  for (const q of ['8', '85', '851', '8517', '85171', '8517130000']) assert.equal(engine.account(u, 'renderHtml', [q]), null);
  assert.equal(engine.usage.get('typing').keys.size, 2, 'набор кода по цифрам — одна позиция');
  // чередование не схлопывается: «ab», «a», «ac» — разные позиции
  const v = { id: 'alternating', email: 'v@example.test' };
  for (const q of ['ab', 'a', 'ac', 'a']) engine.account(v, 'renderHtml', [q]);
  assert.equal(engine.usage.get('alternating').keys.size, 3);
  // позиция — по цифрам запроса, где бы они ни стояли: база вынимает код и из «……8517»
  const pad = '.'.repeat(60);
  assert.deepEqual(k('renderHtml', [pad + '8517130000']), ['t' + pad, 'h8517']);
  assert.deepEqual(k('renderHtml', ['8517.13']), ['t8517.13', 'h8517']);
  assert.deepEqual(k('calcCodeList', ['85.17']), ['h8517']);
  assert.deepEqual(k('calcCodeList', ['z8517']), ['h8517']);
  const p = { id: 'padded', email: 'p@example.test' };
  for (const h of ['0101', '0201', '0301', '0401', '0501']) assert.equal(engine.account(p, 'renderHtml', [pad + h]), null);
  assert.equal(engine.usage.get('padded').keys.size, 6, 'дополнение перед кодом позиций не прячет: текст и пять позиций');
  // слово с цифрами по-прежнему набирается одной текстовой позицией
  const n = { id: 'mixed', email: 'n@example.test' };
  for (const q of ['болт м', 'болт м1', 'болт м12', 'болт м1234', 'болт м12345']) assert.equal(engine.account(n, 'renderHtml', [q]), null);
  assert.deepEqual([...engine.usage.get('mixed').keys].sort(), ['h1234', 'tболт м12345'].map(engine.tag).sort());
  // две строки одной позиции в одном запросе — одна новая позиция и у предела
  const b = { id: 'bundle', email: 'b@example.test' };
  assert.equal(engine.account(b, 'codeBundle', [['8517130000', '8517120000']]), null);
  assert.equal(engine.usage.get('bundle').keys.size, 1);
  console.log('PASS: позиции — код по товарной позиции, слово по продолжению набора');
}

// ── Лимиты и письмо ──
{
  const w = { id: 'wide', email: '<b>wide</b>@example.test' };
  const heads = ['0101', '0201', '0301', '0401', '0501', '0601', '0701', '0801', '0901', '1001'];
  const res = heads.map((h) => engine.account(w, 'renderHtml', [h]));
  assert.deepEqual(res, [null, null, null, null, null, null, null, null, 'engine_limit_day', 'engine_limit_day']);
  // уже открытые позиции после предела остаются доступны
  assert.equal(engine.account(w, 'renderHtml', ['0101 10']), null);
  const m = { id: 'minute', email: 'm@example.test' };
  let refused = null;
  for (let i = 0; i < 31 && !refused; i++) refused = engine.account(m, 'renderHtml', ['8517'], 1_000_000);
  assert.equal(refused, 'engine_limit_minute');
  assert.equal(engine.account(m, 'renderHtml', ['8517'], 1_000_000 + 60_000), null, 'через минуту снова можно');
  setImmediate(() => {
    const wide = mails.filter((x) => /wide/.test(x.subject));
    assert.equal(wide.length, 2, 'по одному письму: «много» и «лимит»');
    assert.ok(wide.every((x) => x.to === 'admin@example.test'));
    assert.ok(wide.every((x) => x.html.includes('&lt;b&gt;wide&lt;/b&gt;') && !x.html.includes('<b>wide</b>')));
    console.log('PASS: лимиты — минута, позиции за сутки; письмо администраторам одно на повод, адрес экранирован');
  });
}

// ── Счётчики переживают перезапуск: файл, метки вместо текста, сутки по Бишкеку ──
{
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-usage-'));
  const file = path.join(dir, 'engine-usage.json');
  process.env.ENGINE_STATE_FILE = file;
  process.env.SESSION_SECRET = 'test-session-secret';
  // «Перезапуск» — тот же модуль, прочитанный заново: свой usage, тот же файл и тот же ключ меток.
  const restart = () => {
    delete require.cache[require.resolve('../src/routes/engine')];
    return require('../src/routes/engine');
  };
  const day1 = Date.UTC(2026, 9, 1, 3, 0); // 09:00 1 октября в Бишкеке
  const r = { id: 'restart-user', email: 'restart@example.test' };
  const e1 = restart();
  for (const q of ['0101', '0201', '0301', 'Смартфон']) assert.equal(e1.account(r, 'renderHtml', [q], day1), null);
  assert.equal(e1.saveState(day1), true);
  assert.equal(e1.saveState(day1 + 1000), false, 'без новых запросов файл не переписывается');
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!/0101|0201|0301|смартфон|restart@/i.test(saved), 'в файле нет ни кодов, ни фраз, ни адреса');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['engine-usage.json'], 'временный файл не остаётся');

  const e2 = restart();
  assert.equal(e2.loadState(day1 + 60e3), 1);
  assert.equal(e2.usage.get('restart-user').keys.size, 4);
  assert.equal(e2.usage.get('restart-user').calls, 4);
  assert.equal(e2.account(r, 'renderHtml', ['0101 10'], day1 + 120e3), null);
  assert.equal(e2.usage.get('restart-user').keys.size, 4, 'открытая до перезапуска позиция новой не считается');
  // предел (8 в этом тесте) отсчитывается от сохранённых позиций, а не с нуля
  const more = ['0401', '0501', '0601', '0701', '0801'].map((h) => e2.account(r, 'renderHtml', [h], day1 + 180e3));
  assert.deepEqual(more, [null, null, null, null, 'engine_limit_day']);
  assert.equal(e2.saveState(day1 + 240e3), true);

  // письма «много» и «лимит» уже ушли — после ещё одного перезапуска не повторяются
  const e3 = restart();
  assert.equal(e3.loadState(day1 + 300e3), 1);
  assert.equal(e3.account(r, 'renderHtml', ['0901'], day1 + 360e3), 'engine_limit_day');
  assert.equal(e3.account(r, 'renderHtml', ['0101'], day1 + 360e3), null, 'открытые позиции после предела доступны');
  setImmediate(() => {
    assert.equal(mails.filter((x) => /restart@/.test(x.subject)).length, 2, 'по письму на повод за сутки, перезапуски не в счёт');
  });

  // новые сутки в Бишкеке (00:30 2 октября): вчерашний файл не читается, сохранение стирает вчерашнее
  const day2 = Date.UTC(2026, 9, 1, 18, 30);
  assert.equal(restart().loadState(day2), 0);
  assert.equal(e3.saveState(day1 + 400e3), true);
  assert.equal(e3.saveState(day1 + 500e3), false);
  assert.equal(e3.saveState(day2), true, 'смена суток переписывает файл и без новых запросов');
  assert.equal(e3.usage.has('restart-user'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, day: '2026-10-02', users: [] });
  // битый файл и чужой формат — ноль, без исключения
  fs.writeFileSync(file, '{oops');
  assert.equal(restart().loadState(day1), 0);
  fs.writeFileSync(file, JSON.stringify({ v: 1, day: '2026-10-01', users: [[42, { keys: ['x'] }], ['ok', { keys: [1, 'y'], calls: 'z' }]] }));
  const e4 = restart();
  assert.equal(e4.loadState(day1), 1);
  assert.deepEqual([...e4.usage.get('ok').keys], ['y']);
  assert.equal(e4.usage.get('ok').calls, 0);
  // запросы, пришедшие раньше чтения файла, складываются с сохранёнными
  const e5 = restart();
  e5.account({ id: 'ok', email: 'ok@example.test' }, 'renderHtml', ['0101'], day1);
  e5.loadState(day1);
  assert.deepEqual([e5.usage.get('ok').calls, e5.usage.get('ok').keys.size], [1, 2]);
  // init() читает файл и сохраняет по таймеру; tick — то же, что делает остановка процесса
  fs.rmSync(file);
  const e6 = restart();
  const tick = e6.init();
  e6.account({ id: 'tick', email: 't@example.test' }, 'renderHtml', ['8517']);
  tick();
  e6.stop();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).users[0][0], 'tick');
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.ENGINE_STATE_FILE;
  console.log('PASS: счётчики переживают перезапуск — метки вместо текста, права 600, предел и письма от сохранённого, вчерашнее стирается');
}

// ── Маршрут ──
(async () => {
  const app = express();
  app.use(express.json());
  let user = null;
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/api/engine', engine);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/engine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await post({ fn: 'renderHtml', args: ['8517130000'] })).status, 401);
    user = { id: 'u1', email: 'u1@example.test', role: 'user', email_verified_at: null };
    assert.equal((await post({ fn: 'renderHtml', args: ['8517130000'] })).status, 403);
    user = { id: 'u1', email: 'u1@example.test', role: 'user', email_verified_at: new Date() };
    for (const fn of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'ENGINE_API', 'ETT_DB', 'findBan', 'eval', 42, null]) {
      assert.deepEqual(await post({ fn, args: [] }), { status: 400, body: { error: 'unknown_function' } }, String(fn));
    }
    const ok = await post({ fn: 'renderHtml', args: ['8517130000'] });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result.cards, true);
    assert.match(ok.body.result.html, /8517 13 000 0/);
    const bundle = await post({ fn: 'codeBundle', args: [['8517130000', 'x', 5, '1'.repeat(10)]] });
    assert.deepEqual(Object.keys(bundle.body.result).sort(), ['1111111111', '8517130000']);
    assert.equal(bundle.body.result['1111111111'], null);
    assert.equal((await post({ fn: 'autoModels', args: ['__proto__'] })).body.result.length, 0);
    // администратор без лимитов: сверка базы — это тысячи запросов
    user = { id: 'adm', email: 'adm@example.test', role: 'admin', email_verified_at: new Date() };
    for (let i = 0; i < 40; i++) assert.equal((await post({ fn: 'calcCodeList', args: [String(1000 + i * 17)] })).status, 200);
    console.log('PASS: /api/engine — 401/403, только функции ENGINE_API, аргументы из сети, администратор без лимитов');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
