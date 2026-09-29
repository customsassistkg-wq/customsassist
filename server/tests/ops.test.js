// node server/tests/ops.test.js
// Разбор находок из Telegram (routes/ops.js) на настоящем src/index.js с подменённой базой:
// webhook пропускается проверкой Origin и защищён своим секретом; команды — только из чатов
// администраторов; «разобрать» запускает рутину с текстом сводки и не запускает второй раз;
// отчёт рутины — по своему секрету, с проверкой ветки и коммита; «выложи» кладёт заявку и
// не кладёт вторую. Плюс чистые функции службы выкладки (server/ops/deploy-branch.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-'));
process.env.OPS_STATE_DIR = state;
process.env.APP_ORIGIN = 'https://test.local';
process.env.SESSION_SECRET = 'local-check-only';
process.env.TELEGRAM_BOT_TOKEN = '123:test';
process.env.TELEGRAM_ADMIN_CHAT_IDS = '111,222';
process.env.TELEGRAM_WEBHOOK_SECRET = 'w'.repeat(40);
process.env.OPS_REPORT_SECRET = 'r'.repeat(40);
process.env.ROUTINE_FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
process.env.ROUTINE_TOKEN = 'sk-ant-oat01-test';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;

require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async () => ({ rows: [] }) } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

// Сеть наружу подменена: Telegram и рутина записываются, локальный сервер — настоящий.
const realFetch = global.fetch;
const sent = [];
const fired = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(opts.body)); return new Response('{"ok":true}', { status: 200 }); }
  if (u === process.env.ROUTINE_FIRE_URL) {
    fired.push({ auth: opts.headers.authorization, beta: opts.headers['anthropic-beta'], text: JSON.parse(opts.body).text });
    return new Response(JSON.stringify({ type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_test' }), { status: 200 });
  }
  return realFetch(url, opts);
};

const app = require('../src/index');
const ops = require('../src/services/ops');
const { command } = require('../src/routes/ops');
const dep = require('../ops/deploy-branch');
const tick = () => new Promise((r) => setTimeout(r, 30));

(async () => {
  // ── разбор команд ──
  assert.equal(command('Разобрать').name, 'fix');
  assert.equal(command('/выложи').name, 'deploy');
  assert.equal(command('разобрать только квоту').rest, 'только квоту');
  assert.equal(command('/статус@CustomsAssistKG_bot').name, 'status');
  assert.equal(command('разобраться бы'), null, 'слово целиком, а не начало другого');
  assert.equal(command('привет'), null);
  console.log('PASS: команды — «разобрать», «/выложи», «статус@бот», пожелание после команды; «разобраться» — не команда');

  // ── служба выкладки: заявка и допустимые файлы ──
  assert.ok(dep.validRequest({ branch: 'claude/watch-20260929-0600', commit: 'a'.repeat(40) }));
  assert.ok(!dep.validRequest({ branch: 'main', commit: 'a'.repeat(40) }));
  assert.ok(!dep.validRequest({ branch: 'claude/x;rm -rf /', commit: 'a'.repeat(40) }));
  assert.ok(!dep.validRequest({ branch: 'claude/x', commit: 'abc' }));
  assert.deepEqual(dep.classify(['server/private/base.js', 'session.md', 'docs/source-audit.md', 'server/tests/engine.test.js']),
    { bad: [], deploy: ['server/private/base.js'] });
  assert.deepEqual(dep.classify(['server/private/checker.js', 'tnved_checker.html', 'server/src/index.js', 'server/scripts/watch-sources.js']).bad,
    ['server/private/checker.js', 'tnved_checker.html', 'server/src/index.js']);
  assert.deepEqual(dep.parseEnv('A=1\nTELEGRAM_BOT_TOKEN="x:y"\n# c\nB = two words'), { A: '1', TELEGRAM_BOT_TOKEN: 'x:y', B: 'two words' });
  console.log('PASS: выкладка — только ветка claude/… с полным коммитом; страница, checker.js и src/ отклоняются; .env читается без зависимостей');

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const hook = (body, secret = process.env.TELEGRAM_WEBHOOK_SECRET) => fetch(base + '/api/ops/telegram', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(body),
  });
  const say = (chat, text, reply) => hook({ update_id: 1, message: { message_id: 5, chat: { id: chat }, text, ...(reply ? { reply_to_message: { text: reply } } : {}) } });
  const report = (body, secret = process.env.OPS_REPORT_SECRET) => fetch(base + '/api/ops/report', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ops-secret': secret }, body: JSON.stringify(body),
  });
  const last = () => sent.at(-1) && sent.at(-1).text;
  try {
    // Без Origin — не «bad origin»: путь исключён из проверки, решает секрет маршрута.
    let r = await hook({}, 'wrong');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'forbidden');
    assert.equal((await report({ status: 'no-change' }, 'wrong')).status, 403);
    console.log('PASS: webhook и отчёт без Origin доходят до маршрута; чужой секрет — 403');

    await say(999, 'разобрать', 'сводка');
    await tick();
    assert.equal(fired.length, 0);
    assert.equal(sent.length, 0, 'чужому чату не отвечаем');
    console.log('PASS: команда из чужого чата молча отброшена');

    await say(111, 'выложи');
    await tick();
    assert.match(last(), /Выкладывать нечего/);

    await say(111, 'разобрать только квоту', '📋 Дозор источников: 1 находка\n• квота электромобилей');
    await tick();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].auth, 'Bearer ' + process.env.ROUTINE_TOKEN);
    assert.equal(fired[0].beta, 'experimental-cc-routine-2026-04-01');
    assert.match(fired[0].text, /квота электромобилей/);
    assert.match(fired[0].text, /Пожелание владельца к разбору: только квоту/);
    assert.match(last(), /Запустил разбор.*session_test/s);
    await say(222, 'разобрать', 'ещё раз');
    await tick();
    assert.equal(fired.length, 1, 'пока нет отчёта — второй запуск не делается');
    assert.match(last(), /уже идёт/);
    console.log('PASS: «разобрать» ответом на сводку запускает рутину с её текстом и пожеланием; повтор до отчёта — не запускает');

    assert.equal((await report({ status: 'changed', branch: 'main', commit: 'a'.repeat(40) })).status, 400);
    assert.equal((await report({ status: 'changed', branch: 'claude/watch-1', commit: 'xyz' })).status, 400);
    assert.equal((await report({ status: 'maybe' })).status, 400);
    const sha = 'b'.repeat(40);
    r = await report({ status: 'changed', branch: 'claude/watch-20260929-1000', commit: sha, summary: 'Квота <исчерпана>' });
    assert.equal(r.status, 200);
    await tick();
    assert.equal(sent.filter((m) => /Разбор готов/.test(m.text)).length, 2, 'отчёт — обоим администраторам');
    assert.match(last(), /Квота &lt;исчерпана&gt;/, 'текст отчёта экранирован');
    assert.equal(ops.state().report.commit, sha);
    console.log('PASS: отчёт — только ветка claude/… и полный коммит; пересылается администраторам экранированным');

    await say(111, 'выложи');
    await tick();
    const req = ops.readJson('deploy-request.json');
    assert.deepEqual([req.branch, req.commit, req.chat], ['claude/watch-20260929-1000', sha, '111']);
    assert.match(last(), /Выкладываю ветку/);
    await say(111, 'выложи');
    await tick();
    assert.match(last(), /Выкладка уже идёт/);
    await say(111, 'статус');
    await tick();
    assert.match(last(), /Выкладка: идёт/);
    console.log('PASS: «выложи» кладёт одну заявку с веткой и коммитом отчёта; вторая — «уже идёт»; «статус» это показывает');

    // Новый разбор после отчёта снова разрешён.
    fs.rmSync(path.join(state, 'deploy-request.json'));
    ops.saveWatchReport('Дозор источников 29.09.2026\n- [реестр, закон] Закон № 150');
    await say(111, 'разобрать');
    await tick();
    assert.equal(fired.length, 2);
    assert.match(fired[1].text, /Последний полный отчёт дозора источников:\nДозор источников 29\.09\.2026/);
    console.log('PASS: после отчёта «разобрать» без ответа на сводку берёт последний полный отчёт дозора');
  } finally {
    server.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
