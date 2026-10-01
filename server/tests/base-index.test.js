// node server/tests/base-index.test.js
// Поиск по коду в больших перечнях идёт через корзины первых четырёх знаков (head4Add / head4Candidates, rowsByHead4,
// trEaeuIndex, ntmIndex в base.js) вместо прохода по всем строкам: с 01.10.2026 запрос по коду считается ~10 мс, а не ~45.
// Здесь результат сверяется с прямым просмотром — прежним алгоритмом, записанным заново — на запросах из самих данных
// (все позиции, префиксы, полные коды, коды короче четырёх знаков) и на «мусоре»: порядок строк, «первый подходящий код
// строки» и снятие повторов должны остаться прежними. Запрос короче четырёх знаков индекс не использует.
const assert = require('node:assert/strict');
const B = require('../src/services/base').load();

// Ответы базы строятся в другом контексте vm (свой Object.prototype), поэтому сравнение — через JSON: порядок и значения.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const refTREAEU = (q) => {
  const qn = B.norm(q); if (!qn || qn.length < 4) return [];
  const res = [];
  for (const [trNum, tr] of Object.entries(B.TR_EAEU_DB)) {
    for (const item of tr.items) {
      const [num, name, codes, form, note] = item;
      for (const [code, partial] of codes) {
        const cn = B.norm(code);
        if (cn.startsWith(qn) || qn.startsWith(cn.slice(0, Math.min(qn.length, 10)))) {
          res.push({ trNum, trName: tr.name, act: tr.act, url: tr.url, transition: tr.transition, noList: tr.noList, from: tr.from, fromN: tr.fromN, num, name, code, partial, form, note });
          break;
        }
      }
    }
  }
  return res;
};

const refEEC30 = (q) => {
  const qn = B.norm(q); if (!qn || qn.length < 4) return [];
  const seen = new Set(), res = [];
  for (const [section, name, codes, , note] of B.NTM_DB) {
    if (!codes || !codes.length) continue;
    for (const code of codes) {
      const iz = /^из\s/.test(code), cn = B.norm(iz ? code.replace(/^из\s+/, '') : code);
      if (!cn) continue;
      if (cn.startsWith(qn) || qn.startsWith(cn.slice(0, Math.min(qn.length, cn.length)))) {
        const key = section + name;
        if (!seen.has(key)) {
          seen.add(key);
          res.push({ code, name, section, dir: B.NTM_BAN_DIR[section] || B.ntmDir(name), regime: B.ntmRegime(section), note: note || null, partial: cn.length <= 4 || iz, iz });
        }
        break;
      }
    }
  }
  return res;
};

const digitsOf = (q) => B.norm(q).replace(/\D/g, '');
const refETT = (q) => { const qn = digitsOf(q); return !qn || qn.length < 4 ? [] : B.ETT_DB.filter((r) => r[0].startsWith(qn)); };
// findETTUAE при прямых совпадениях отдаёт именно их; без них идёт ветка прежней номенклатуры, которой корзины не касаются.
const refUAE = (q) => { const qn = digitsOf(q); if (!qn || qn.length < 4) return null; const d = B.ETT_UAE_DB.filter((r) => r[0].startsWith(qn)); return d.length ? d : null; };

// Запросы берутся из самих данных: коды всех четырёх перечней.
const all = new Set();
for (const r of B.ETT_DB) all.add(String(r[0]));
for (const r of B.ETT_UAE_DB) all.add(String(r[0]));
for (const tr of Object.values(B.TR_EAEU_DB)) for (const item of tr.items) for (const c of item[2]) all.add(String(c[0]));
for (const row of B.NTM_DB) for (const c of (row[2] || [])) all.add(String(c).replace(/^из\s+/, ''));
const codes = [...all].map((c) => c.replace(/\s+/g, '')).filter(Boolean);

const queries = new Set();
const heads = new Set(codes.filter((c) => c.length >= 4).map((c) => c.slice(0, 4)));
[...heads].forEach((h, i) => { if (i % 3 === 0 || !B.ETT_DB.some((r) => r[0].startsWith(h))) queries.add(h); }); // позиции перечней — все, позиции ЕТТ — каждая третья
codes.forEach((c, i) => {
  if (i % 47 === 0) queries.add(c);
  if (i % 61 === 0 && c.length > 5) queries.add(c.slice(0, 5 + (i % (c.length - 4))));
});
// коды короче четырёх знаков (главы «85», позиции из трёх знаков) совпадают с любым запросом, который с них начинается
const shortCodes = codes.filter((c) => c.length < 4);
for (const c of shortCodes) for (const tail of ['01', '17', '99', '0000', '000000']) queries.add((c + tail).slice(0, 10));
// не коды: пробелы, точки, буквы, регистр, длинные и пустые
for (const q of ['', ' ', 'abc', 'АБВГ', 'смартфон', '85', '851', '8517x', ' 85 17 13 ', '8517.13', '8517-13', '8517130000999', 'ИЗ 8517', 'из 8517', '8517\n13', '\t8517',
  'a'.repeat(5000), '9'.repeat(30), '0000', '0001', '9999', 'EX8517', 'ex 8517', '8517 13 000 0', '85171300']) queries.add(q);

let n = 0;
const hit = { tr: 0, eec: 0, ett: 0, uae: 0 };
for (const q of queries) {
  n++;
  const a = B.findTREAEU(q), b = refTREAEU(q);
  assert.ok(same(a, b), 'findTREAEU расходится с прямым просмотром на запросе ' + JSON.stringify(q.slice(0, 40)));
  const c = B.findEEC30(q), d = refEEC30(q);
  assert.ok(same(c, d), 'findEEC30 расходится с прямым просмотром на запросе ' + JSON.stringify(q.slice(0, 40)));
  const e = B.findETT(q), f = refETT(q);
  assert.ok(same(e, f), 'findETT расходится с прямым просмотром на запросе ' + JSON.stringify(q.slice(0, 40)));
  const g = refUAE(q);
  if (g) assert.ok(same(B.findETTUAE(q), g), 'findETTUAE расходится с прямым просмотром на запросе ' + JSON.stringify(q.slice(0, 40)));
  if (a.length) hit.tr++;
  if (c.length) hit.eec++;
  if (e.length) hit.ett++;
  if (g) hit.uae++;
}
// проверка не пустая: каждый перечень действительно отвечает на заметную часть запросов
assert.ok(n >= 400, 'запросов слишком мало: ' + n);
assert.ok(hit.tr >= 50 && hit.eec >= 50 && hit.ett >= 100 && hit.uae >= 10, 'мало непустых ответов: ' + JSON.stringify(hit));
console.log(`PASS: поиск по кодам через корзины = прямой просмотр: ${n} запросов; непустые ответы — ТР ${hit.tr}, Единый перечень ${hit.eec}, ЕТТ ${hit.ett}, ЕТТ ОАЭ ${hit.uae}; коротких кодов в перечнях ${shortCodes.length}`);

// Возвращённый массив принадлежит вызывающему: правка его не должна портить индекс.
for (const [name, fn, q] of [['findETT', B.findETT, '8517'], ['findTREAEU', B.findTREAEU, '8517'], ['findEEC30', B.findEEC30, '2903'], ['findETTUAE', B.findETTUAE, '0201']]) {
  const first = fn(q);
  assert.ok(first.length > 0, name + ': пример без результата');
  const len = first.length;
  first.length = 0;
  assert.equal(fn(q).length, len, name + ': правка результата испортила следующий ответ');
}
console.log('PASS: результат поиска не разделяет изменяемое состояние с индексом');
