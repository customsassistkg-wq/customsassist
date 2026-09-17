// node server/tests/assistant.test.js
// AI-помощник без сети и без DeepSeek: инструменты в vm и цикл вызовов модели
// на подменённом fetch. Живое качество ответов — server/tests/assistant-eval.js.
const assert = require('node:assert/strict');
process.env.AI_API_KEY = 'test';
const nbkr = require('../src/services/nbkrRates');
nbkr.getRates = async () => ({ date: '16.09.2026', usd: 87.45, eur: 100.9086, rates: { USD: 87.45, EUR: 100.9086, CNY: 12.3 } });
const a = require('../src/services/assistant');

(async () => {
  // ── тарифы: лимит вопросов в день и в месяц ──
  {
    let used = 0, today = 0;
    const inserts = [];
    const user = { id: 'u1', email: 'u@x.kg', role: 'user', active: true, email_verified_at: new Date(), ai_plan: 'base' };
    require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => {
      if (/count\(\*\)::int as used/.test(sql)) return { rows: [{ used, used_today: today }] };
      if (/insert into assistant_log/.test(sql)) { inserts.push(args); return { rows: [{ id: inserts.length }] }; }
      if (/update users set ai_plan/.test(sql)) return { rows: [{ id: 'u1', ai_plan: 'pro' }] };
      return { rows: [user] };
    } } } };
    const express = require('express');
    // Маршрут берёт ask при загрузке: подменяем на время require, модель не нужна.
    let askImpl = async () => ({ answer: 'ok', searched: [], unverified: [], usage: {} });
    const realAsk = a.ask;
    a.ask = (...args) => askImpl(...args);
    const route = require('../src/routes/assistant');
    a.ask = realAsk;
    // граница месяца — полночь по Бишкеку: 30.09 19:00 UTC — это уже 1 октября
    assert.equal(route.bishkekMonth(new Date('2026-09-30T19:00:00Z')).start.toISOString(), '2026-09-30T18:00:00.000Z');
    assert.equal(route.bishkekMonth(new Date('2026-09-30T17:59:00Z')).start.toISOString(), '2026-08-31T18:00:00.000Z');
    // и граница дня: 16.09 18:30 UTC — уже 17 сентября в Бишкеке
    assert.equal(route.bishkekDay(new Date('2026-09-16T18:30:00Z')).start.toISOString(), '2026-09-16T18:00:00.000Z');
    assert.deepEqual(Object.values(route.PLANS).map((p) => [p.day, p.month]), [[3, 100], [20, 300], [60, 1000]]);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = user; next(); });
    app.use('/api/assistant', route);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/assistant';
    const post = () => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
    try {
      // Базовый: 3 за сегодня — отказ до завтра
      used = 10; today = 3;
      let r = await post();
      assert.equal(r.status, 429);
      let j = await r.json();
      assert.equal(j.error, 'quota_exceeded');
      assert.deepEqual([j.quota.remaining, j.quota.blockedBy, j.quota.remainingMonth], [0, 'day', 90]);
      assert.equal(j.quota.plans.max.day, 60);
      // месяц исчерпан — держит месяц, даже если сегодня вопросов не было
      used = 100; today = 0;
      j = await (await post()).json();
      assert.deepEqual([j.quota.remaining, j.quota.blockedBy], [0, 'month']);
      // остаток — по меньшему из лимитов
      used = 37; today = 1;
      j = await (await fetch(base + '/quota')).json();
      assert.deepEqual([j.plan, j.remainingDay, j.remainingMonth, j.remaining], ['base', 2, 63, 2]);
      user.ai_plan = 'max'; used = 999; today = 10;
      j = await (await fetch(base + '/quota')).json();
      assert.deepEqual([j.name, j.remaining, j.blockedBy], ['Max', 1, 'month']);
      user.role = 'admin'; used = 5000; today = 500;
      j = await (await fetch(base + '/quota')).json();
      assert.deepEqual([j.limit, j.remaining], [null, null]);
      user.role = 'user'; user.ai_plan = 'непонятный';
      j = await (await fetch(base + '/quota')).json();
      assert.equal(j.plan, 'base');                 // неизвестный тариф — как базовый, а не без лимита
      // второй вопрос того же пользователя, пока первый в работе, — отказ «busy»:
      // лимит считается по журналу, а запись появляется только после ответа
      used = 0; today = 0;
      let release;
      const started = new Promise((ok) => { askImpl = async () => {
        if (release) return { answer: 'второй пропущен', searched: [], unverified: [], usage: {} }; // без занятости — сразу, а не зависание
        ok(); await new Promise((d) => { release = d; }); return { answer: 'ok', searched: [], unverified: [], usage: {} };
      }; });
      const first = post();
      await started;
      r = await post();
      assert.deepEqual([r.status, (await r.json()).error], [429, 'busy']);
      release();
      r = await first;
      assert.equal(r.status, 200);
      assert.match(await r.text(), /"answer":"ok"/);
      // упавший вопрос освобождает место, а его расход попадает в журнал
      askImpl = async () => { throw Object.assign(new Error('AI API 500: boom'), { usage: { input: 7, output: 3, cacheRead: 0, costUsd: 0.25 } }); };
      r = await post();
      assert.match(await r.text(), /ai_unavailable/);
      const logged = inserts[inserts.length - 1];
      assert.deepEqual([logged[9], logged[6], logged[11]], ['AI API 500: boom', 7, 0.25]);
      askImpl = async () => ({ answer: 'ok2', searched: [], unverified: [], usage: {} });
      assert.match(await (await post()).text(), /ok2/);
    } finally { server.close(); }
    console.log('PASS: тарифы — день и месяц по Бишкеку, отказ по дню и по месяцу, остаток по меньшему, админ, неизвестный тариф');
  }

  // ── search_base ──
  let t = a.searchBase({ query: '8517130000' });
  assert.match(t, /8517 13 000 0/);
  assert.match(t, /Ставка ввозной пошлины/);
  assert.match(t, /^НДС при импорте: 12%/);
  assert.doesNotMatch(t, /Разобраны официальные PDF/);       // отчёт о сверке вырезан
  assert.doesNotMatch(t, /<div/);
  assert.doesNotMatch(t, /исключён из реестра|срок внесения истёк/); // недействующие строки ТРОИС
  assert.match(t, /действующие товарные знаки \(\d+\)/);          // без «4 из 35»
  assert.doesNotMatch(t, /ЕСТП/);                                 // ставка 0% — преференции не нужны
  assert.match(a.searchBase({ query: '3004310000' }), /^НДС при импорте: 0%/);

  // вывоз: карточки «только ввоз» убраны; ЕАЭС: тарифные убраны
  assert.doesNotMatch(a.searchBase({ query: '8517130000', direction: 'ex' }), /Ставка ввозной пошлины|НДС при импорте/);
  assert.doesNotMatch(a.searchBase({ query: '8517130000', country: 'Казахстан' }), /Ставка ввозной пошлины/);
  assert.match(a.searchBase({ query: '0201100001', country: 'ОАЭ', date: '2026-09-16' }), /13,1%.*06\.10\.2026/);

  // наименование — полные названия: 8517 13 и 8517 14 различаются только хвостом
  t = a.searchBase({ query: 'смартфон' });
  assert.match(t, /Кандидаты по наименованию/);
  assert.match(t, /8517 13 000 0 — .*смартфоны — ставка 0%/);

  // дополнительное примечание ЕАЭС подставляется к наименованию кода
  assert.match(a.searchBase({ query: '0207146001' }), /Дополнительное примечание ЕАЭС 4 к группе 02: .*при наличии лицензии/);
  assert.equal(a.searchBase({ query: '' }), 'Пустой запрос.');
  console.log('PASS: search_base — отбор карточек, НДС, ТРОИС, примечания, наименования');

  // ── group_notes ──
  t = a.groupNotes({ chapter: '85' });
  assert.match(t, /Раздел XVI/);
  assert.match(t, /термин "смартфоны" означает/);
  assert.match(t, /ru\.85_2022/);
  assert.match(a.groupNotes({ chapter: '1' }), /Группа 01/);
  console.log('PASS: group_notes');

  // ── сноски ЕЭК к ставкам и наименованиям ──
  // 128С: 0% с 01.07.2026 по 30.06.2027 — видна сейчас, не видна после срока
  assert.match(a.searchBase({ query: '2710124110', date: '2026-09-16' }), /Сноска ЕЭК 128С к ставке ЕТТ: .*0 \(ноль\) %/);
  assert.doesNotMatch(a.searchBase({ query: '2710124110', date: '2027-07-01' }), /128С/);
  // 58С истекла «30 апреля 2025 г.» — срок прописью тоже распознаётся
  assert.doesNotMatch(a.searchBase({ query: '1803100000' }), /58С/);
  assert.match(a.searchBase({ query: '2519901001' }), /Сноска ЕЭК 5\) к наименованию позиции: При подтверждении/);
  assert.match(await a.calcPayments({ code: '2710124110', value: 1000, currency: 'USD', quantity: 100 }), /ВНИМАНИЕ — к коду есть сноски ЕЭК/);
  // ставка криолита исправлена по изображению стр. 11 группы 28: «5,5 63С)», а не «5»
  assert.equal(a.checker().ETT_DB.find((r) => r[0] === '2826300000')[3], 5.5);
  console.log('PASS: сноски ЕЭК — срок, чужая страна, прописью, в расчёте');

  // ── calc_payments ──
  t = await a.calcPayments({ code: '0207146001', value: 2000, currency: 'USD', quantity: 1000 });
  // 2000 × 87,45 = 174 900; max(25% = 43 725; 0,2 € × 1000 кг × 100,9086 = 20 181,72) = 43 725
  assert.match(t, /Ввозная пошлина: 43\s725,00 сом/);
  assert.match(t, /НДС 12%: 26\s235,00 сом/);                     // (174 900 + 43 725) × 12%
  assert.match(t, /Сбор за таможенные операции: 699,60 сом/);      // 0,4%
  assert.match(t, /Итого: 70\s659,60 сом/);
  assert.match(await a.calcPayments({ code: '0207146001', value: 2000, currency: 'USD' }), /нужно количество/);
  assert.match(await a.calcPayments({ code: '8517130000', value: 100, currency: 'USD', country: 'Казахстан' }), /ЕАЭС/);
  assert.match(await a.calcPayments({ code: '0201100001', value: 5000, currency: 'USD', quantity: 1000, country: 'ОАЭ', date: '2026-10-10' }), /ОАЭ: 13,1%/);
  assert.match(await a.calcPayments({ code: '1', value: 1, currency: 'USD' }), /не найден в ЕТТ/);
  console.log('PASS: calc_payments — пошлина «не менее», НДС, сбор, ЕАЭС, ОАЭ');

  // ── стоимость раунда по ценам DeepSeek ──
  const u = { input_tokens: 1e6, cache_read_input_tokens: 1e6, output_tokens: 1e6 };
  const peak = new Date('2026-09-16T07:00:00Z');    // среда 07:00 UTC — пик
  const off = new Date('2026-09-16T12:00:00Z');     // среда 12:00 UTC — вне пика
  const sat = new Date('2026-09-19T07:00:00Z');     // суббота — вне пика в любой час
  assert.equal(a.roundCost(u, 'deepseek-v4-flash', peak).toFixed(3), (0.30 + 0.006 + 1.20).toFixed(3));
  assert.equal(a.roundCost(u, 'deepseek-v4-flash', off).toFixed(3), ((0.30 + 0.006 + 1.20) / 2).toFixed(3));
  assert.equal(a.roundCost(u, 'deepseek-v4-flash', sat).toFixed(3), ((0.30 + 0.006 + 1.20) / 2).toFixed(3));
  assert.equal(a.roundCost(u, 'deepseek-v4-pro', peak).toFixed(3), (1.32 + 0.044 + 3.96).toFixed(3));
  assert.equal(a.roundCost(undefined, 'x', peak), 0);
  console.log('PASS: стоимость — пик, вне пика, выходные, кэш, pro');

  // ── служебные проверки ответа ──
  assert.deepEqual([...a.codesIn('8517 13 000 0 и 0207142001, но не 12345678901 и 8517 13')], ['8517130000', '0207142001']);
  assert.equal(a.keepKnownLinks('[ЕТТ](https://customs.gov.kg) и [№30](https://docs.eaeunion.org/d/1/)', 'текст [№30](https://docs.eaeunion.org/d/1/)'),
    'ЕТТ и [№30](https://docs.eaeunion.org/d/1/)');
  console.log('PASS: коды и ссылки в ответе');

  // ── цикл модели ──
  const calls = [];
  let script;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return { ok: true, json: async () => ({ content: script(calls.length), usage: { input_tokens: 10, output_tokens: 5 } }) };
  };
  script = (n) => (n === 1
    ? [{ type: 'tool_use', id: 't1', name: 'search_base', input: { query: '8517130000' } }]
    : [{ type: 'text', text: 'Код 8517 13 000 0, ставка 0%. [ЕТТ](https://example.com/fake)' }]);
  const steps = [];
  let r = await a.ask([{ role: 'user', content: 'Какая пошлина на смартфон?' }], { onStep: (s) => steps.push(s) });
  assert.equal(r.answer, 'Код 8517 13 000 0, ставка 0%. ЕТТ');      // выдуманная ссылка стала текстом
  assert.deepEqual(r.searched, ['8517130000']);
  assert.deepEqual(r.unverified, []);
  assert.equal(r.usage.input, 20);
  assert.equal(r.usage.output, 10);
  assert.ok(r.usage.costUsd > 0);
  assert.deepEqual(steps, [{ tool: 'search_base', input: { query: '8517130000' } }]);
  assert.deepEqual(calls[0].tool_choice, { type: 'tool', name: 'search_base' }); // без поиска ответить нельзя
  assert.equal(calls[1].tool_choice, undefined);
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
  assert.match(calls[1].messages[2].content[0].content, /8517 13 000 0/);
  assert.ok(calls[0].tools.some((x) => x.name === 'group_notes'));
  console.log('PASS: принудительный первый поиск, шаги, токены, защита ссылок');

  // код, которого не было в выдаче: один повторный раунд, затем пометка
  calls.length = 0;
  script = (n) => (n === 1
    ? [{ type: 'tool_use', id: 't1', name: 'search_base', input: { query: 'смартфон' } }]
    : [{ type: 'text', text: 'Берите код 9999 99 999 9.' }]);
  r = await a.ask([{ role: 'user', content: 'смартфон' }]);
  assert.equal(calls.length, 3);
  assert.match(calls[2].messages[calls[2].messages.length - 1].content, /коды 9999999999 не встречались/);
  assert.deepEqual(r.unverified, ['9999999999']);
  // код из прошлого ответа модели не подтверждён: историю присылает браузер;
  // код, который назвал сам пользователь, выдуманным не считается
  script = (n) => (n === 1
    ? [{ type: 'tool_use', id: 't1', name: 'search_base', input: { query: 'смартфон' } }]
    : [{ type: 'text', text: 'Коды 9999 99 999 8 и 9999 99 999 9.' }]);
  r = await a.ask([{ role: 'user', content: 'товар 9999 99 999 8' }, { role: 'assistant', content: 'Берите 9999 99 999 9.' }, { role: 'user', content: 'а ставка?' }]);
  assert.deepEqual(r.unverified, ['9999999999']);
  console.log('PASS: неподтверждённый код — повторная проверка и пометка, прошлый ответ модели не подтверждает');

  // вопрос, упавший после оплаченного раунда, уносит расход с ошибкой
  let n = 0;
  global.fetch = async () => (++n === 1
    ? { ok: true, json: async () => ({ content: [{ type: 'tool_use', id: 't1', name: 'group_notes', input: { chapter: '85' } }], usage: { input_tokens: 10, output_tokens: 5 } }) }
    : { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) });
  await assert.rejects(a.ask([{ role: 'user', content: 'x' }]), (e) => e.usage.input === 10 && e.usage.costUsd > 0);
  console.log('PASS: расход упавшего вопроса прикреплён к ошибке');

  global.fetch = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: 'Insufficient Balance' } }) });
  await assert.rejects(a.ask([{ role: 'user', content: 'x' }]), /Insufficient Balance/);
  console.log('PASS: ошибка API пробрасывается');
})().catch((e) => { console.error(e); process.exit(1); });

// Разметка ответа в браузере: Markdown без HTML модели, без javascript:-ссылок,
// коды — переходом к карточке, но не внутри уже существующей ссылки.
{
  const vm = require('node:vm');
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '../private/checker.js'), 'utf8');
  const esc = src.match(/function esc\(s\)\{[^\n]*\}/)[0];
  const md = src.slice(src.indexOf('function aiMd(t){'), src.indexOf('function renderAiPage('));
  const sb = {}; vm.createContext(sb);
  vm.runInContext(esc + '\n' + md + '\nthis.aiMd=aiMd;', sb);
  const h = sb.aiMd('### Итог\n**Код:** 8517 13 000 0\n- пошлина 0%\n- [ЕТТ 8517130000](https://eec.eaeunion.org/x)\n<img src=x onerror=alert(1)> [x](javascript:alert(1))');
  assert.match(h, /<h4>Итог<\/h4>/);
  assert.match(h, /<b>Код:<\/b> <a href="#" class="ai-code" data-code="8517130000">8517 13 000 0<\/a>/);
  assert.match(h, /<li><a href="https:\/\/eec\.eaeunion\.org\/x" target="_blank" rel="noopener">ЕТТ 8517130000<\/a><\/li>/);
  assert.doesNotMatch(h, /<img/);
  assert.doesNotMatch(h, /href="javascript/);
  console.log('PASS: Markdown ответа экранируется, коды кликабельны');
}
