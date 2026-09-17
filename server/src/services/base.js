// База сайта на сервере. private/base.js — перечни, ставки, реестры и все функции,
// которые их читают; private/checker.js — интерфейс и общие помощники (esc, norm,
// fmtCode…). Оба файла исполняются в одном vm-контексте с заглушками DOM. Браузер
// получает только checker.js и спрашивает базу через /api/engine (routes/engine.js);
// помощник вызывает те же функции напрямую (services/assistant.js).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '../../private');
let ctx = null;

// Разбор 12 МБ занимает секунду-другую и ~150 МБ памяти; сервер вызывает load() при
// старте, чтобы первый поиск пользователя этого не ждал. Тесты загружают по требованию.
function load() {
  if (ctx) return ctx;
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
  // checker.js первым: верхний уровень base.js при загрузке уже вызывает его помощники.
  for (const f of ['checker.js', 'base.js']) {
    new vm.Script(fs.readFileSync(path.join(DIR, f), 'utf8'), { filename: f }).runInContext(sb);
  }
  // const верхнего уровня не становятся свойствами sandbox — берём их выражением в том же контексте.
  ctx = new vm.Script('({ENGINE_API,renderHtml,findByName,lkCountry,lkCtyMatch,lkPrefRates,ETT_DB,fmtCode,fmtRate,'
    + 'TNVED_MAP,parseRateInfo,itemDuty,vatFreeHits,customsFeeGoods,findExcise,calcWarnings})').runInContext(sb);
  return ctx;
}

// Только собственные ключи ENGINE_API: «constructor», «__proto__» и прочее унаследованное — не функции базы.
function has(fn) {
  return typeof fn === 'string' && Object.prototype.hasOwnProperty.call(load().ENGINE_API, fn);
}

function call(fn, args) {
  if (!has(fn)) throw Object.assign(new Error('unknown engine function'), { status: 400 });
  const result = load().ENGINE_API[fn](...(Array.isArray(args) ? args.slice(0, 4) : []));
  return result === undefined ? null : result;
}

module.exports = { load, has, call };
