// node tools/base-sweep.js [--all]
// Обязательные проверки базы после любого импорта (docs/source-audit.md): длины кодов, живость по ЕТТ,
// повторы внутри списка кодов, повторяющиеся ключи объектных литералов, разбор ставок ЕТТ.
// Известные и задокументированные исключения перечислены в KNOWN; всё сверх них — находка, код выхода 1.
// --all печатает и известные. Сеть не нужна.
//
// Живость считается по ОФИЦИАЛЬНОМУ набору: ETT_DB минус строки, которые TNVED_MAP помечает gone/typo
// (158 кодов, которых нет в ЕТТ, — docs/base-architecture.md). Проверка по сырому ETT_DB пропустила
// несуществующую цель 3105 30 001 1 в TNVED_MAP (22.09.2026).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = process.env.BASE_DIR || path.join(__dirname, '../server/private'); // BASE_DIR — проверить другую копию базы
const showAll = process.argv.includes('--all');

// Тот же контекст, что в server/src/services/base.js (заглушки DOM), но с доступом к любым константам.
const noop = () => {};
const boxes = {};
const el = (id) => boxes[id] || (boxes[id] = {
  id, addEventListener: noop, insertAdjacentHTML: noop, appendChild: noop, setAttribute: noop,
  getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  style: {}, dataset: {}, innerHTML: '', value: '', textContent: '',
});
const sb = {
  console, setTimeout: noop, clearTimeout: noop, addEventListener: noop,
  localStorage: { getItem: () => null, setItem: noop },
  fetch: () => Promise.reject(new Error('offline')),
  document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => el(Symbol()), addEventListener: noop, body: el('body') },
};
sb.window = sb;
vm.createContext(sb);
for (const f of ['checker.js', 'base.js']) new vm.Script(fs.readFileSync(path.join(DIR, f), 'utf8'), { filename: f }).runInContext(sb);
const g = (expr) => new vm.Script(expr).runInContext(sb);

const KNOWN = {
  // длина не 2/4/6/8/9/10: самый длинный живой префикс кода, который акт пишет по прежней редакции (source-audit.md)
  len: new Set(['NKS_MAP:68151', 'NKS_MAP:84622', 'NKS_ITCAT:68151', 'NKS_ITCAT:84622', 'TNVED_MAP_keys:68151', 'TNVED_MAP_keys:84622',
    'SERT_CODES:44181', 'SERT_CODES:44182', 'MAT_CODES:29142', 'MAT_CODES:1515905', 'MAT_CODES:2930909']),
  // кода нет в ЕТТ и нет в TNVED_MAP: опечатки самого акта (перечень к Пост. № 709), помечены в наименовании
  dead: new Set(['ART297_P26_SPORT_CODES:850491', 'ART297_P26_SPORT_CODES:903400']),
  // базы, где мёртвые коды и повторы — свойство источника: реестр ТРОИС; в EEC_DECISIONS коды идут по товарам решения
  deadDb: new Set(['TROIS_DB']),
  dupDb: new Set(['TROIS_DB', 'EEC_DECISIONS']),
  // повторы ключей с одинаковым значением; NKS_ITCAT — приём переименования (поздний ключ побеждает)
  dupKeys: { NKS_MAP: 0, TNVED_MAP: 2, SEARCH_SYNONYMS: 1 }, // NKS_MAP: повторы 391000000 и 84622 схлопнуты 24.09.2026 (побеждало то же последнее значение)
};

const ETT = g('ETT_DB'), TN = g('TNVED_MAP');
const phantom = new Set(ETT.map((r) => r[0]).filter((c) => TN[c] && (TN[c].b === 'gone' || TN[c].b === 'typo')));
const official = ETT.map((r) => r[0]).filter((c) => !phantom.has(c));
const prefixes = new Set();
for (const c of official) for (let i = 2; i <= 10; i++) prefixes.add(c.slice(0, i));
const mapped = (c) => Object.keys(TN).some((k) => k === c || c.startsWith(k) || k.startsWith(c));

const X = {};
const keysOf = (n) => () => Object.keys(g(n)).map((k) => ({ code: k }));
for (const n of ['NKS_MAP', 'NKS_ITCAT', 'LS_CODES', 'SERT_CODES', 'MED_CODES', 'MAT_CODES', 'ART297_CODES', 'ART300_CODES', 'ART299_CODES', 'POST131_APP6_VET_CODES',
  'ART297_P20_VIE_CODES', 'ART297_P26_SPORT_CODES', 'ART297_P30_JEWEL_CODES', 'EEC_WASTE', 'KEF1606_MAP']) X[n] = keysOf(n);
const lists = (n, pick) => () => g(n).flatMap((r, i) => (pick(r) || []).map((c) => ({ code: c, list: i })));
for (const n of ['BAN_DB', 'VET_DB', 'PHYTO_DB', 'SAN_REG_DB', 'SAN_SUB_DB']) X[n] = lists(n, (r) => r.codes);
for (const n of ['ART301_GROUP1', 'ART301_GROUP2', 'RS_CHEESE']) X[n] = () => g(n).map((c) => ({ code: c, list: 0 }));
for (const n of ['ART297_PERECHEN_LISTS', 'ART298_LISTS']) X[n] = () => g(n).flatMap((l) => Object.keys(l.codes).map((c) => ({ code: c })));
X.TR_EAEU_DB = () => Object.entries(g('TR_EAEU_DB')).flatMap(([k, tr]) => (tr.items || []).flatMap((it, i) => (it[2] || []).map((cc) => ({ code: Array.isArray(cc) ? cc[0] : cc, list: k + ':' + i }))));
for (const n of ['ETT_UAE_DB', 'ETT_MN_DB', 'ETT_RS_DB', 'ETT_IRAN_DB', 'ETT_VN_DB']) X[n] = () => g(n).map((r) => ({ code: r[0] }));
X.NBNDS_DB = () => g('NBNDS_DB').map((r) => ({ code: r[1] }));
for (const [n, idx] of [['ANTIDUMP_DB', 0], ['TRIGGER_DB', 0], ['QUOTA_DB', 0], ['NTM_DB', 2], ['EEC_DECISIONS', 1]]) X[n] = lists(n, (r) => r[idx]);
X.TROIS_DB = () => g('TROIS_DB').flatMap((r) => (r[9] || []).map((c) => ({ code: String(c), list: r[0] })));
X.UNIMEAS_DB = () => g('UNIMEAS_DB').flatMap((r, i) => [6, 7, 8, 9].flatMap((k) => (Array.isArray(r[k]) ? r[k] : []).filter((c) => /^\d+$/.test(c)).map((c) => ({ code: c, list: i + ':' + k }))));
X.TNVED_MAP_keys = () => Object.keys(TN).map((k) => ({ code: k }));
X.TNVED_MAP_targets = () => Object.entries(TN).flatMap(([k, v]) => (v.t || []).map((c) => ({ code: c, list: k, target: true })));

const findings = [], known = [];
const report = (kind, db, code, note) => {
  const isKnown = (kind === 'len' && KNOWN.len.has(db + ':' + code)) || (kind === 'dead' && (KNOWN.dead.has(db + ':' + code) || KNOWN.deadDb.has(db))) || (kind === 'dup' && KNOWN.dupDb.has(db));
  (isKnown ? known : findings).push(`${kind.padEnd(5)} ${db} «${code}»${note ? ' — ' + note : ''}`);
};
let total = 0;
for (const [db, fn] of Object.entries(X)) {
  const seen = new Set();
  for (const r of fn()) {
    total++;
    let c = String(r.code == null ? '' : r.code);
    if (/^\d+>\d*$/.test(c)) c = c.split('>')[1];             // ТРОИС: «код акта>живой префикс»
    if (c === '') continue;                                   // у кода акта нет живого префикса — сказано на карточке
    const d = c.replace(/^из\s+/, '').replace(/\s+/g, '');
    if (!/^\d+$/.test(d)) continue;                           // диапазоны и группы пишутся своим форматом
    if (![2, 4, 6, 8, 9, 10].includes(d.length)) report('len', db, d);
    if (d.length <= 10 && !prefixes.has(d) && db !== 'TNVED_MAP_keys') {
      if (r.target) report('dead', db, d, 'цель TNVED_MAP вне официального набора ЕТТ (ключ ' + r.list + ')');
      else if (!mapped(d)) report('dead', db, d, 'нет в ЕТТ и нет в TNVED_MAP');
    }
    if (r.list !== undefined) { const k = r.list + '|' + d; if (seen.has(k)) report('dup', db, d, 'повтор внутри одного списка'); seen.add(k); }
  }
}

// ЕТТ: уникальность и разбор ставок
const ettCodes = ETT.map((r) => r[0]);
if (new Set(ettCodes).size !== ettCodes.length) findings.push('ett   повторяющиеся коды в ETT_DB');
for (const r of ETT) { if (!/^\d{10}$/.test(r[0])) findings.push('ett   не 10 знаков: ' + r[0]); }
const parse = g('parseRateInfo'), types = {};
for (const r of ETT) { const t = parse(r[3]).type; types[t] = (types[t] || 0) + 1; if (t === 'complex' || t === 'unknown') findings.push('rate  ' + r[0] + ' ставка не разбирается: ' + JSON.stringify(r[3])); if (typeof r[3] === 'string' && /[A-Za-z]/.test(r[3])) findings.push('rate  ' + r[0] + ' латиница в ставке: ' + r[3]); }

// Повторяющиеся ключи верхнего уровня объектных литералов base.js
const src = fs.readFileSync(path.join(DIR, 'base.js'), 'utf8');
const re = /^const\s+([A-Z][A-Z0-9_]+)\s*=\s*\{/gm;
let m;
while ((m = re.exec(src))) {
  const name = m[1];
  if (name === 'NKS_ITCAT') continue;
  let i = m.index + m[0].length, depth = 1, expectKey = true;
  const count = new Map();
  const add = (key) => { count.set(key, (count.get(key) || 0) + 1); expectKey = false; };
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      if (depth === 1 && expectKey) { let k = j + 1; while (/\s/.test(src[k])) k++; if (src[k] === ':') add(src.slice(i + 1, j)); }
      i = j + 1; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 1) expectKey = true;
    else if (depth === 1 && expectKey && /[A-Za-z_$0-9]/.test(c)) { let j = i; while (/[A-Za-z_$0-9]/.test(src[j])) j++; let k = j; while (/\s/.test(src[k])) k++; if (src[k] === ':') add(src.slice(i, j)); i = j; continue; }
    i++;
  }
  const dups = [...count.entries()].filter(([, n]) => n > 1).length;
  if (dups !== (KNOWN.dupKeys[name] || 0)) findings.push(`keys  ${name}: повторяющихся ключей ${dups}, ожидалось ${KNOWN.dupKeys[name] || 0}`);
}

console.log(`кодов проверено: ${total}; ЕТТ ${ETT.length} строк, из них вне официального набора ${phantom.size}; типы ставок ${JSON.stringify(types)}`);
console.log(`известных исключений: ${known.length}; новых находок: ${findings.length}`);
if (showAll) for (const k of known) console.log('  (известно) ' + k);
for (const f of findings) console.log('  ' + f);
process.exitCode = findings.length ? 1 : 0;
