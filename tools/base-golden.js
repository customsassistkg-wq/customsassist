// node tools/base-golden.js save <файл.json>      — снять «эталон»: хеши ответов базы на ~5 700 запросов
// node tools/base-golden.js compare <файл.json>   — снять заново и показать, что изменилось (код выхода 1, если что-то)
// Зачем (01.10.2026): правка, которая не должна менять ответы (ускорение, перестройка функции, перенос кода), доказывается
// сравнением: эталон снимается ДО правки, сравнение — ПОСЛЕ, и «ВСЕ ОТВЕТЫ ПОБАЙТНО ТЕ ЖЕ» — это доказательство, а не надежда.
// Правка данных, наоборот, должна менять ровно то, что задумано: compare перечисляет изменившиеся запросы по группам
// (r4 — позиции, r6 — подпозиции, r10 — коды, rd — на дату, rn — по названию, cl/cb/sl/lk/tc — калькулятор и дерево…).
// Набор: все четырёхзначные позиции ЕТТ, шестая часть шестизначных, каждый двадцатый код, коды с временными ставками,
// запросы на даты 2025-03-01 / 2026-10-08 / 2027-01-15, 60 названий, странные формы запроса, и остальные функции ENGINE_API.
// Занимает ~1–2 минуты, сеть не нужна. Файл эталона в репозиторий не кладётся (он про состояние базы на день снимка).
// Ответы зависят от даты (по умолчанию «сегодня» по Бишкеку): эталон и сравнение снимайте в один день.
const fs = require('node:fs');
const crypto = require('node:crypto');
const base = require('../server/src/services/base');
const ctx = base.load();
const h = (x) => crypto.createHash('sha1').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 14);
const out = {};
function put(k, fn) {
  let v;
  try { v = fn(); } catch (e) { v = 'ERR ' + e.message; }
  out[k] = h(v === undefined ? 'undef' : v);
}
const call = (fn, args) => base.call(fn, args);
const rows = ctx.ETT_DB;
const heads = [...new Set(rows.map((r) => r[0].slice(0, 4)))];
const sixes = [...new Set(rows.map((r) => r[0].slice(0, 6)))].filter((_, i) => i % 6 === 0);
const tens = rows.map((r) => r[0]);
const tensSample = tens.filter((_, i) => i % 20 === 0);
const temps = []; // коды с временными ставками (ETT_TEMP не экспортирован — берём коды из карточек ниже)
for (const c of ['8112924101', '8112924109', '2823000000', '8108300000', '2602000000', '2710124110']) temps.push(c);
const t0 = Date.now();
for (const q of heads) put('r4:' + q, () => call('renderHtml', [q, '']));
for (const q of sixes) put('r6:' + q, () => call('renderHtml', [q, '']));
for (const q of tensSample.concat(temps)) put('r10:' + q, () => call('renderHtml', [q, '']));
const dateSample = tens.filter((_, i) => i % 90 === 0).concat(temps);
for (const d of ['2026-10-08', '2025-03-01', '2027-01-15']) for (const q of dateSample) put(`rd:${d}:${q}`, () => call('renderHtml', [q, d]));
const odd = ['8517.13', '85 17 13', ' 8517130000 ', '8517130000x', 'ИЗ 8517', '', 'abc', '0', '99999999999', '8517 13 000 0', '....8517', '85', '8', '851', '0000', '9999', '7777777777'];
for (const q of odd) put('rodd:' + q, () => call('renderHtml', [q, '']));
const names = ['смартфон', 'масло', 'мясо говядина', 'автомобиль', 'пшеница', 'сыр', 'вино', 'трактор', 'лекарство', 'кабель', 'батарея', 'молоко', 'сахар', 'табак', 'сигареты', 'пиво', 'водка', 'древесина', 'уголь', 'нефть', 'золото', 'удобрение', 'семена', 'саженцы', 'лошадь', 'береза', 'осётр', 'медведь', 'ноутбук', 'принтер', 'телевизор', 'холодильник', 'шины', 'обувь', 'ткань', 'мебель', 'игрушки', 'велосипед', 'мотоцикл', 'двигатель', 'насос', 'краска', 'пластик', 'бумага', 'стекло', 'сталь', 'алюминий', 'медь', 'chicken', 'phone', 'ab', 'я', 'х', 'прочие', 'новые', 'бывшие в употреблении', 'электрические', 'оборудование', 'части', 'аксессуары'];
for (const q of names) { put('rn:' + q, () => call('renderHtml', [q, ''])); put('sp:' + q, () => call('speciesHtml', [q])); }
for (const q of heads) put('cl:' + q, () => call('calcCodeList', [q]));
for (const q of tensSample.slice(0, 200)) put('cl10:' + q, () => call('calcCodeList', [q]));
for (let i = 0; i < tens.length; i += 25 * 20) put('cb:' + i, () => call('codeBundle', [tens.filter((_, j) => j >= i && j < i + 25 * 20 && (j - i) % 20 === 0)]));
for (let i = 0; i < tens.length; i += 25 * 17) put('sl:' + i, () => call('specLookup', [tens.filter((_, j) => j >= i && j < i + 25 * 17 && (j - i) % 17 === 0)]));
for (const q of tensSample.filter((_, i) => i % 3 === 0)) put('cw:' + q, () => call('calcWarnings', [q]));
for (let nn = 1; nn <= 97; nn++) { const s = String(nn).padStart(2, '0'); put('tc:' + s, () => call('treeChapter', [s, 2000, ''])); put('tch:' + s, () => call('treeChapter', [s, 50, s + '01'])); }
for (const cty of ['', 'Китай', 'Россия', 'Вьетнам', 'Индия', 'Сербия', 'Казахстан']) for (const d of ['', '2026-10-08']) for (let i = 0; i < tens.length; i += 25 * 40) put(`lk:${cty}:${d}:${i}`, () => call('lkRates', [tens.filter((_, j) => j >= i && j < i + 25 * 40 && (j - i) % 40 === 0), cty, d]));
put('audit', () => call('sourceAuditHtml', []));
for (const k of ['personal', 'ban', 'trois', 'tr', 'species', 'nokey']) put('an:' + k, () => call('auditNote', [k]));
put('ab', () => call('autoBrands', []));
const brands = call('autoBrands', []);
for (const b of brands.slice(0, 40)) { put('am:' + b, () => call('autoModels', [b])); for (const m of (call('autoModels', [b]) || []).slice(0, 5)) put(`av:${b}:${m}`, () => call('autoVariants', [b, m])); }
console.log('items', Object.keys(out).length, 'ms', Date.now() - t0);
const [mode, file] = process.argv.slice(2);
if (!['save', 'compare'].includes(mode) || !file) { console.error('node tools/base-golden.js save|compare <файл.json>'); process.exit(2); }
if (mode === 'save') { fs.writeFileSync(file, JSON.stringify(out)); console.log('saved', file); }
else if (mode === 'compare') {
  const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bad = Object.keys(prev).filter((k) => prev[k] !== out[k]);
  const extra = Object.keys(out).filter((k) => !(k in prev));
  const groups = {};
  for (const k of bad) { const g = k.split(':')[0]; groups[g] = (groups[g] || 0) + 1; }
  console.log(bad.length || extra.length ? `РАСХОЖДЕНИЙ: ${bad.length} (новых ключей ${extra.length}); по группам: ${JSON.stringify(groups)}` : 'ВСЕ ОТВЕТЫ ПОБАЙТНО ТЕ ЖЕ');
  if (bad.length) console.log('первые:', bad.slice(0, 15).join(' | '));
  process.exit(bad.length || extra.length ? 1 : 0);
}
