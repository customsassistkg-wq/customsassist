// node server/tests/assistant.test.js
// AI-помощник без сети и без DeepSeek: инструменты в vm и цикл вызовов модели
// на подменённом fetch. Живое качество ответов — server/tests/assistant-eval.js.
const assert = require('node:assert/strict');
process.env.AI_API_KEY = 'test';
const nbkr = require('../src/services/nbkrRates');
nbkr.getRates = async () => ({ date: '16.09.2026', usd: 87.45, eur: 100.9086, rates: { USD: 87.45, EUR: 100.9086, CNY: 12.3 } });
const a = require('../src/services/assistant');

(async () => {
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
  assert.deepEqual(r.usage, { input: 20, output: 10 });
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
  console.log('PASS: неподтверждённый код — повторная проверка и пометка');

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
