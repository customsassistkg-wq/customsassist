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

// ── Остальные перечни: кандидаты из корзин = все совпадающие записи прямого просмотра, в прежнем порядке ──
// Цикл вызывающей функции (findSert, findMat, findNBNDS, …) остался прежним и сам проверяет совпадение; поэтому достаточно,
// чтобы отобранные записи, прошедшие то же условие, совпали с прямым просмотром — по составу и по порядку.
const P10 = (qn) => (e) => { const cn = B.norm(e[0]); return cn.startsWith(qn) || qn.startsWith(cn.slice(0, Math.min(qn.length, 10))); };
const Pcn = (qn) => (e) => { const cn = B.norm(e[0]); return cn.startsWith(qn) || qn.startsWith(cn.slice(0, Math.min(qn.length, cn.length))); };
const Pact = (qn) => (e) => B.actCodeNote(B.norm(e[0]), qn) !== false;
const keys = (a) => a.map((e) => (Array.isArray(e) ? e[0] + '|' + (typeof e[1] === 'string' ? e[1] : '') : e));

function listQueries(items, keyOf) {
  const own = new Set();
  const ks = items.map(keyOf).map((k) => String(k).replace(/\s+/g, '')).filter(Boolean);
  for (const k of ks) if (k.length >= 4) own.add(k.slice(0, 4));
  ks.forEach((k, i) => { if (i % 7 === 0) own.add(k); if (i % 11 === 0 && k.length > 5) own.add(k.slice(0, 5 + (i % (k.length - 4)))); });
  for (const k of ks) if (k.length < 4) for (const tail of ['01', '17', '99', '0000']) own.add((k + tail).slice(0, 10));
  const some = [...queries].filter((_, i) => i % 3 === 0);
  return [...new Set([...own, ...some])].filter((q) => B.norm(q).length >= 4);
}
let listChecks = 0;
function checkList(name, items, cands, pred, keyOf) {
  const qs = listQueries(items, keyOf);
  for (const q of qs) {
    const qn = B.norm(q), p = pred(qn);
    const full = items.filter(p), viaIndex = cands(qn).filter(p);
    assert.ok(same(keys(full), keys(viaIndex)), `${name}: кандидаты теряют или переставляют записи на запросе ${JSON.stringify(q.slice(0, 40))}`);
    listChecks++;
  }
}
const dicts = [['SERT_CODES', P10], ['MED_CODES', P10], ['LS_CODES', P10], ['POST131_APP6_VET_CODES', P10], ['MAT_CODES', P10], ['ART299_CODES', P10],
  ['EEC_WASTE', Pcn], ['ART297_P20_VIE_CODES', Pact], ['ART297_P26_SPORT_CODES', Pact]];
for (const [name, pred] of dicts) {
  const L = B[name];
  assert.ok(L && Object.keys(L).length > 0, name + ': перечень не отдан');
  checkList(name, Object.entries(L), (qn) => (pred === Pact ? B.actCands(L, qn) : B.codeCands(L, qn)), pred, (e) => e[0]);
}
for (const [group, lists] of [['ART297_PERECHEN_LISTS', B.ART297_PERECHEN_LISTS], ['ART298_LISTS', B.ART298_LISTS]]) {
  lists.forEach((list, n) => checkList(`${group}[${n}]`, Object.entries(list.codes), (qn) => B.actCands(list.codes, qn), Pact, (e) => e[0]));
}
checkList('NBNDS_DB', B.NBNDS_DB, (qn) => B.head4Items(B.NBNDS_DB, (r) => r[1], B.ACT_LEGACY, qn), (qn) => (r) => B.actCodeNote(r[1], qn) !== false, (r) => r[1]);
const legacy = B.legacyMapFor(B.NKS, (c) => c);
checkList('NKS', [...B.NKS], (qn) => B.head4Items(B.NKS, (c) => c, (c) => legacy.has(c), qn),
  (qn) => (c) => c.startsWith(qn) || qn.startsWith(c.slice(0, Math.min(qn.length, 10))) || (legacy.has(c) && B.legacyAppliesTo(legacy.get(c).at, qn)), (c) => c);
// Кодов прежней редакции в НКС сейчас может не быть (8112 92 410 0 станет таким 08.10.2026) — путь «всегда кандидат» проверяется ниже на настоящей таблице TNVED_MAP.
assert.ok(listChecks >= 3000, 'проверок перечней слишком мало: ' + listChecks);

// ТРОИС: короткая и громоздкая функция — полная сверка с прежним алгоритмом.
const refTROIS = (q) => {
  const qn = B.norm(q); if (!qn || qn.length < 4) return [];
  const res = [];
  for (const rec of B.TROIS_DB) {
    let hit = '';
    for (const raw of rec[9]) {
      const gt = raw.indexOf('>'), c = gt < 0 ? raw : raw.slice(gt + 1);
      if (c.length === 2) { if (qn.slice(0, 2) === c) { hit = raw; break; } continue; }
      if (c.startsWith(qn) || qn.startsWith(c)) { hit = raw; break; }
    }
    if (hit) res.push({ rec, code: hit });
  }
  res.sort((x, y) => (y.rec[4] - x.rec[4]) || (x.rec[0] < y.rec[0] ? -1 : 1));
  return res;
};
let troisQ = 0, troisHit = 0;
for (const q of listQueries(B.TROIS_DB.flatMap((r) => r[9].map((raw) => [raw.slice(raw.indexOf('>') + 1)])), (e) => e[0])) {
  const a = B.findTROIS(q), b = refTROIS(q);
  assert.ok(same(a, b), 'findTROIS расходится с прямым просмотром на запросе ' + JSON.stringify(q.slice(0, 40)));
  troisQ++; if (a.length) troisHit++;
}
assert.ok(troisQ >= 300 && troisHit >= 100, `ТРОИС: запросов ${troisQ}, непустых ${troisHit}`);
// Путь «запись — кандидат при любом запросе» (код прежней номенклатуры): синтетический список и настоящая таблица соответствия TNVED_MAP.
{
  const alwaysSet = new Set(['9999999999', '']);
  const items = ['85', '851', '8517', '85171300', '8517130000', '8517139000', '8518', '9999999999', '0', ''];
  const pred = (qn) => (c) => c.startsWith(qn) || qn.startsWith(c.slice(0, Math.min(qn.length, 10))) || alwaysSet.has(c);
  for (const q of ['8517', '85171', '8517130000', '8518', '9999', '0000', '1234', '85171300001', '851713']) {
    const qn = B.norm(q);
    assert.ok(same(items.filter(pred(qn)), B.head4Items(items.slice(), (c) => c, (c) => alwaysSet.has(c), qn).filter(pred(qn))), 'синтетический список, запрос ' + q);
  }
  const keys = Object.keys(B.TNVED_MAP);
  const qs = new Set();
  for (const k of keys) {
    qs.add(k.length >= 4 ? k : k + '0000');
    for (const t of B.TNVED_MAP[k].t) { qs.add(t); if (t.length >= 4) qs.add(t.slice(0, 4)); if (t.length >= 8) qs.add(t.slice(0, 8)); }
  }
  let viaLegacy = 0, checked = 0;
  const direct = (c, qn) => c.startsWith(qn) || qn.startsWith(c.slice(0, Math.min(qn.length, 10)));
  for (const q of qs) {
    const qn = B.norm(q); if (qn.length < 4) continue;
    const p = (c) => B.actCodeNote(c, qn) !== false;
    const full = keys.filter(p), viaIndex = B.head4Items(keys, (c) => c, B.ACT_LEGACY, qn).filter(p);
    assert.ok(same(viaIndex, full), 'TNVED_MAP: кандидаты расходятся с прямым просмотром на запросе ' + q);
    viaLegacy += full.filter((c) => !direct(c, qn)).length; checked++;
  }
  assert.ok(checked >= 300 && viaLegacy >= 50, `TNVED_MAP: проверено ${checked} запросов, совпадений только через преемников ${viaLegacy} — проверка пути «прежняя номенклатура» была бы пустой`);
  console.log(`PASS: запись «кандидат при любом запросе»: синтетический список; таблица соответствия TNVED_MAP — ${checked} запросов, ${viaLegacy} совпадений через преемников кода`);
}

console.log(`PASS: остальные перечни через корзины = прямой просмотр: ${listChecks} сверок по ${dicts.length + B.ART297_PERECHEN_LISTS.length + B.ART298_LISTS.length + 2} перечням (в НКС кодов прежней редакции: ${legacy.size}); ТРОИС — ${troisQ} запросов, непустых ${troisHit}`);
