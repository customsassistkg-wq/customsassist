// node server/tests/assistant.test.js
// AI-помощник без сети: поиск по базе в vm и цикл вызовов модели на подменённом fetch.
const assert = require('node:assert/strict');
process.env.AI_API_KEY = 'test';
const { searchBase, ask } = require('../src/services/assistant');

(async () => {
  let t = searchBase({ query: '8517130000' });
  assert.match(t, /8517 13 000 0/);
  assert.match(t, /Ставка ввозной пошлины/);
  assert.doesNotMatch(t, /Разобраны официальные PDF/); // отчёт о сверке вырезан
  assert.doesNotMatch(t, /<div/);

  assert.match(searchBase({ query: 'смартфон' }), /8517 13 000 0/);
  assert.match(searchBase({ query: '0201100001', country: 'ОАЭ', date: '2026-09-16' }), /13,1%.*06\.10\.2026/);
  assert.match(searchBase({ query: '8471300000', country: 'Казахстан' }), /член ЕАЭС/);
  assert.equal(searchBase({ query: '' }), 'Пустой запрос.');
  console.log('PASS: search_base по коду, наименованию и стране');

  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const content = calls.length === 1
      ? [{ type: 'tool_use', id: 't1', name: 'search_base', input: { query: '8517130000' } }]
      : [{ type: 'text', text: 'Ставка 0%.' }];
    return { ok: true, json: async () => ({ content }) };
  };
  const r = await ask([{ role: 'user', content: 'Какая пошлина на смартфон 8517130000?' }]);
  assert.equal(r.answer, 'Ставка 0%.');
  assert.deepEqual(r.searched, ['8517130000']);
  assert.deepEqual(calls[0].tool_choice, { type: 'tool', name: 'search_base' });  // без поиска ответить нельзя
  assert.equal(calls[1].tool_choice, undefined);
  assert.match(calls[1].messages[2].content[0].content, /8517 13 000 0/);
  assert.match(calls[0].system, /search_base/);
  console.log('PASS: первый раунд — принудительный поиск, результат уходит модели');

  global.fetch = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: 'Insufficient Balance' } }) });
  await assert.rejects(ask([{ role: 'user', content: 'x' }]), /Insufficient Balance/);
  console.log('PASS: ошибка API пробрасывается');
})().catch((e) => { console.error(e); process.exit(1); });

// Разметка ответа в браузере: Markdown без HTML модели и без javascript:-ссылок.
{
  const vm = require('node:vm');
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '../private/checker.js'), 'utf8');
  const esc = src.match(/function esc\(s\)\{[^\n]*\}/)[0];
  const md = src.slice(src.indexOf('function aiMd(t){'), src.indexOf('function renderAiPage('));
  const sb = {}; vm.createContext(sb);
  vm.runInContext(esc + '\n' + md + '\nthis.aiMd=aiMd;', sb);
  const h = sb.aiMd('### Итог\n**Код:** 8517 13 000 0\n- пошлина 0%\n- [ЕТТ](https://eec.eaeunion.org/x)\n<img src=x onerror=alert(1)> [x](javascript:alert(1))');
  assert.match(h, /<h4>Итог<\/h4>/);
  assert.match(h, /<b>Код:<\/b>/);
  assert.match(h, /<ul><li>пошлина 0%<\/li><li><a href="https:\/\/eec\.eaeunion\.org\/x"/);
  assert.doesNotMatch(h, /<img/);
  assert.doesNotMatch(h, /href="javascript/);
  console.log('PASS: Markdown ответа экранируется');
}
