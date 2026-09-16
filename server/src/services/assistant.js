// AI-помощник: модель DeepSeek через совместимый с Anthropic API, но отвечает
// она по нашей базе. База — это server/private/checker.js, тот же файл, что
// получает браузер; здесь он исполняется в vm, и инструменты вызывают те же
// функции, что рисуют карточки и считают платежи на сайте. Поэтому модель
// видит ровно то, что увидел бы пользователь, а не пересказ базы, который
// пришлось бы держать в согласии с ~40 функциями findX().
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const classDecisions = require('./classDecisions');
const nbkrRates = require('./nbkrRates');

const CHECKER = path.join(__dirname, '../../private/checker.js');
const NOTES = path.join(__dirname, '../../private/tnved-notes.json');
const PROMPT = fs.readFileSync(path.join(__dirname, '../assistant-prompt.md'), 'utf8');
const API_URL = (process.env.AI_BASE_URL || 'https://api.deepseek.com/anthropic').replace(/\/+$/, '') + '/v1/messages';
const MODEL = process.env.AI_MODEL || 'deepseek-chat';
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CHARS = 40000; // полная выдача по коду — до ~31 тыс. знаков; 14 тыс. отрезали сертификацию
const DIRS = { im: 'ввоз', ex: 'вывоз', tr: 'транзит' };

let ctx = null;
// Загружается при первом вопросе, а не при старте: 12 МБ кода и ~150 МБ памяти
// не нужны процессу, пока помощником никто не пользуется.
function checker() {
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
  new vm.Script(fs.readFileSync(CHECKER, 'utf8')
    + '\nthis.__ai={render,findByName,lkCountry,lkCtyMatch,lkPrefRates,ETT_DB,fmtCode,fmtRate,TNVED_MAP,'
    + 'parseRateInfo,itemDuty,vatFreeHits,customsFeeGoods,findExcise,calcWarnings};').runInContext(sb);
  ctx = { ...sb.__ai, box: el('aiBox') };
  return ctx;
}

let notes;
function notesDb() {
  if (notes === undefined) notes = fs.existsSync(NOTES) ? JSON.parse(fs.readFileSync(NOTES, 'utf8')) : null;
  return notes;
}

// Верхнеуровневые элементы <div>…</div> строки: карточки выдачи или строки
// внутри карточки. Разметка карточек собрана шаблонами, <div> в ней всегда
// закрыт, поэтому счётчика вложенности достаточно.
function splitDivs(html) {
  const out = [];
  const re = /<div\b|<\/div>/g;
  let depth = 0, start = -1, m;
  while ((m = re.exec(html))) {
    if (m[0] === '</div>') {
      depth--;
      if (depth === 0 && start >= 0) { out.push({ start, end: re.lastIndex }); start = -1; }
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return out;
}

// Карточка → текст. Отчёт о сверке (audit-body) — это 2–3 тыс. знаков о том,
// как сверялась база; модели он только съедает окно, статус и дата остаются.
function cardsToText(html) {
  return html
    .replace(/<div class="audit-body">[\s\S]*?<\/div>/g, '')
    .replace(/<button[\s\S]*?<\/button>/g, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
    .replace(/<(br|\/div|\/li|\/tr|\/p|\/summary|\/h\d)[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// Строки ТРОИС со статусом «исключён из реестра» / «срок внесения истёк» мер
// не влекут, а в выдаче по коду их бывает три десятка: модель пересказывала
// их как «записи есть, но недействующие». Карточка сайта их показывает —
// для истории, — а помощнику они не нужны.
function dropInactiveTrois(card) {
  if (!/исключён из реестра|срок внесения истёк/.test(card)) return card;
  // Карточка, где действующих знаков нет вовсе, — целиком про то, чего нет.
  if (/записи в таможенном реестре ОИС есть, но все они исключены/.test(card)) return '';
  // «(4 из 35 записей по коду)» модель читала как 35 действующих знаков.
  let out = card.replace(/\((\d+) из \d+ записей по коду\)/, '($1)')
    .replace(/<div class="uu"[^>]*>…и ещё \d+ записей по этому коду[^<]*<\/div>/, '');
  card = out;
  const rows = [];
  const inner = (html, offset) => {
    for (const d of splitDivs(html)) {
      const block = html.slice(d.start, d.end);
      if (/^<div class="usir-row"/.test(block)) {
        if (/исключён из реестра|срок внесения истёк/.test(block)) rows.push({ start: d.start + offset, end: d.end + offset });
      } else {
        const open = block.indexOf('>') + 1;
        inner(block.slice(open, block.length - 6), d.start + offset + open);
      }
    }
  };
  inner(card, 0);
  for (const r of rows.reverse()) out = out.slice(0, r.start) + out.slice(r.end);
  return out;
}

// Тот же отбор, что делает «Справка по товару» (lkFilter): мера только на ввоз
// не относится к вывозу и транзиту; из ЕАЭС тарифные меры не применяются;
// мера, привязанная к стране, — только для этой страны.
// ettZero — у запрошенного 10-значного кода ставка ЕТТ 0%: тогда преференциальные
// карточки (ЕСТП, ОАЭ, Вьетнам, Иран, Сербия, Монголия) ничего не меняют, а модель
// пересказывала их и путала, кому преференция положена.
function filterCards(html, dir, cty, c, ettZero) {
  let out = '';
  for (const d of splitDivs(html)) {
    let card = html.slice(d.start, d.end);
    const head = card.slice(0, card.indexOf('>') + 1);
    const attr = (n) => (head.match(new RegExp(n + '="([^"]*)"')) || [])[1];
    const dd = attr('data-dir');
    if (dd && dd.split(' ').indexOf(dir) < 0) continue;
    if (dir === 'im' && cty && cty.eaeu && attr('data-kind') === 'tariff') continue;
    if (dir === 'im' && cty && attr('data-cty') && !c.lkCtyMatch(attr('data-cty'), cty)) continue;
    if (ettZero && /class="card c-ett"/.test(head) && attr('data-cty')) continue;
    out += dropInactiveTrois(card);
  }
  return out;
}

// Модель передаёт страну и кодом ISO («KZ»), а lkCountry понимает только названия:
// «KZ» не находился, и для Казахстана оставались тарифные карточки ЕТТ.
const ISO_COUNTRY = { KZ: 'Казахстан', RU: 'Россия', BY: 'Беларусь', AM: 'Армения', KG: 'Кыргызстан', CN: 'Китай',
  AE: 'ОАЭ', VN: 'Вьетнам', IR: 'Иран', RS: 'Сербия', MN: 'Монголия', US: 'США', TR: 'Турция', DE: 'Германия',
  IN: 'Индия', KR: 'Республика Корея', JP: 'Япония', UZ: 'Узбекистан', TJ: 'Таджикистан' };
function country(c, raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  return c.lkCountry(ISO_COUNTRY[s.toUpperCase()] || s);
}

function clip(text) {
  return text.length > MAX_TOOL_CHARS ? text.slice(0, MAX_TOOL_CHARS) + '\n… (выдача обрезана — уточните код)' : text;
}

function searchBase({ query, country: countryName, date, direction } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return 'Пустой запрос.';
  const dir = DIRS[direction] ? direction : 'im';
  const c = checker();
  const cty = country(c, countryName);
  c.box.innerHTML = '';
  c.render(q, 'aiBox');
  const html = c.box.innerHTML;

  // Поиск по наименованию: на сайте названия кандидатов обрезаны до 110 знаков,
  // а у соседних кодов (8517 13 и 8517 14) первые 110 знаков совпадают — модель
  // выбирала код вслепую. Здесь названия полные.
  if (/Найдено товаров по наименованию/.test(html) && !/data-dir=/.test(html)) {
    const list = c.findByName(q).slice(0, 40);
    const rest = splitDivs(html).map((d) => html.slice(d.start, d.end))
      .filter((b) => !/Найдено товаров по наименованию/.test(b)).join('');
    const lines = list.map((r) => `${c.fmtCode(r[0])} — ${r[1]} — ставка ${c.fmtRate(r[3])}`
      + (c.TNVED_MAP[r[0]] ? ' (кода нет в действующем ЕТТ)' : ''));
    return clip([cardsToText(rest), `Кандидаты по наименованию «${q}» (запросите нужный код отдельно):\n${lines.join('\n')}`]
      .filter(Boolean).join('\n\n'));
  }

  // Короткие вставки — впереди карточек: длинную выдачу обрезаем с хвоста.
  const extra = [];
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 4 && digits.length === q.replace(/\s/g, '').length) {
    if (cty && digits.length === 10 && dir === 'im') {
      const row = c.ETT_DB.find((r) => r[0] === digits);
      if (row) {
        const rates = c.lkPrefRates(digits, row[3], cty, date);
        extra.push(`Страна происхождения: ${cty.name}`
          + (cty.eaeu ? ' — государство — член ЕАЭС, ЕТТ во взаимной торговле не применяется.' : '')
          + (rates.length ? '\n' + rates.map((r) => `Ставка ${r.rate}: ${r.basis}${r.note ? '; ' + r.note : ''}${r.pending ? ` (применяется с ${r.pending})` : ''}`).join('\n')
            : (cty.eaeu ? '' : '\nПреференций для этой страны нет — применяется ставка ЕТТ.')));
      }
    }
    // Ставка НДС в карточках не написана, и модель брала её из памяти («20%»).
    // Здесь — то же, что считает калькулятор сайта (runCalc): 12%, 0% по перечню № 596.
    if (digits.length === 10 && dir === 'im' && !(cty && cty.eaeu) && c.ETT_DB.some((r) => r[0] === digits)) {
      const vf = c.vatFreeHits(digits);
      extra.push(vf.firm.length
        ? 'НДС при импорте: 0% — освобождение по перечню ПКМ КР № 596 от 02.09.2026.'
        : 'НДС при импорте: 12% от суммы таможенной стоимости, пошлины и акциза (ст. 310, ч. 4 ст. 311 НК КР)'
          + (vf.cond.length ? '; условное освобождение: ' + vf.cond.map((x) => x.why).join('; ') : '')
          + '. Другие освобождения — только если есть в карточках ниже, и с их условиями.');
    }
    if (digits.length === 10 && dir === 'im') extra.push(...footnotesFor(digits, date));
    const cd = classDecisions.search(digits, 5);
    if (cd.total) {
      extra.push(`Предварительные решения по классификации (справочник НСИ ЕАЭС №1999), всего ${cd.total}:\n`
        + cd.results.map((r) => `${r.code} — ${r.description} (${r.country}): ${String(r.justification || '').slice(0, 400)}`).join('\n'));
    }
  }
  const ettRow = digits.length === 10 ? c.ETT_DB.find((r) => r[0] === digits) : null;
  const ettZero = !!ettRow && (ettRow[3] === 0 || String(ettRow[3]).trim() === '0');
  const cards = cardsToText(filterCards(html, dir, cty, c, ettZero));
  // Наименование «в порядке, указанном в дополнительном примечании 4 к группе 02»
  // модель толковала по памяти («договорная цена»). Текст примечания — рядом.
  const refs = [...cards.matchAll(/дополнительном примечании(?: Евразийского экономического союза)? (\d+) к группе (\d\d)/g)]
    .map((m) => m[1] + ' ' + m[2]);
  for (const ref of [...new Set(refs)]) {
    const [n, ch] = ref.split(' ');
    const note = additionalNote(ch, n);
    if (note) extra.push(`Дополнительное примечание ЕАЭС ${n} к группе ${ch}: ${note}`);
  }
  return clip([...extra, cards].filter(Boolean).join('\n\n')) || 'Пусто.';
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v || '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const som = (n) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' сом';

// Расчёт — теми же itemDuty/vatFreeHits/customsFeeGoods, что и калькулятор
// сайта, и по курсу НБКР, который калькулятор подставляет по умолчанию. Модель
// не считает сама: арифметика ставок «не менее N евро за кг» и преференций —
// ровно то место, где она ошибается.
async function calcPayments({ code, value, currency, quantity, country: countryName, date } = {}) {
  const c = checker();
  const digits = String(code || '').replace(/\D/g, '');
  const row = c.ETT_DB.find((r) => r[0] === digits);
  if (!row) return `Код ${code} не найден в ЕТТ: расчёт возможен только по 10-значному действующему коду.`;
  const rates = await nbkrRates.getRates();
  if (!rates) return 'Курсы НБКР сейчас недоступны — расчёт невозможен.';
  const cur = String(currency || 'USD').toUpperCase().replace('KGS', 'СОМ').replace('SOM', 'СОМ');
  const curRate = cur === 'СОМ' ? 1 : (rates.rates || {})[cur];
  if (!curRate) return `Нет курса НБКР для валюты ${cur}. Доступны: СОМ, ${Object.keys(rates.rates || {}).join(', ')}.`;
  const valueCur = num(value);
  const valueSom = valueCur * curRate;
  const qty = num(quantity);
  const [, name, unit, ettRate] = row;
  const cty = country(c, countryName);
  const lines = [`Код ${c.fmtCode(digits)} — ${name}`,
    `Таможенная стоимость: ${valueCur} ${cur} × ${curRate} (курс НБКР на ${rates.date || 'сегодня'}) = ${som(valueSom)}`];

  const base = { code: digits, name, unit, cur, curRate, valueCur, valueSom, weight: 0, qty,
    eurRate: rates.eur || 0, usdRate: rates.usd || 0, manualDuty: 0, auto: null, pref: 0 };
  const dutyFor = (rate) => {
    const it = { ...base, rate };
    const p = c.parseRateInfo(rate);
    if (p.type === 'complex' || p.type === 'unknown') return null;
    if (['max', 'plus', 'specific', 'usd', 'minof'].includes(p.type) && !qty) return { need: p.unit };
    return c.itemDuty(it, valueSom);
  };
  const asRate = (s) => (/^\s*\d+(?:[.,]\d+)?\s*%?\s*$/.test(String(s)) ? parseFloat(String(s).replace(',', '.')) : s);

  // Взаимная торговля ЕАЭС — не таможенное оформление: считать ей пошлину, НДС
  // при ввозе и таможенный сбор так же, как из третьей страны, было бы неверно.
  if (cty && cty.eaeu) return `Товар из государства — члена ЕАЭС (${cty.name}): взаимная торговля, тарифные меры ЕТТ не применяются, таможенного оформления нет. Этот расчёт — для ввоза из третьих стран.`;
  let duty = null;
  {
    const options = [{ rate: ettRate, basis: 'ставка ЕТТ ' + c.fmtRate(ettRate) }];
    if (cty) {
      for (const r of c.lkPrefRates(digits, ettRate, cty, date)) {
        if (!r.pending) options.push({ rate: asRate(r.rate), basis: `${r.who}: ${r.rate} — ${r.basis}` });
      }
    }
    const done = [];
    for (const o of options) {
      const d = dutyFor(o.rate);
      if (d && d.need) return `Ставка «${c.fmtRate(o.rate)}» специфическая — нужно количество в единицах «${d.need}» (параметр quantity).`;
      if (d) done.push({ ...d, basis: o.basis });
    }
    if (!done.length) return `Ставку «${c.fmtRate(ettRate)}» автоматически посчитать нельзя — нужен ручной расчёт.`;
    done.sort((a, b) => a.duty - b.duty);
    duty = { duty: done[0].duty, note: `${done[0].basis}; ${done[0].note}` };
    if (done.length > 1) lines.push('Сравнены основания: ' + done.map((d) => `${d.basis} → ${som(d.duty)}`).join('; ')
      + '. Преференция — только при подтверждении происхождения.');
  }
  lines.push(`Ввозная пошлина: ${som(duty.duty)} (${duty.note})`);

  const vf = c.vatFreeHits(digits);
  const vatRate = vf.firm.length ? 0 : 12;
  const vat = (valueSom + duty.duty) * vatRate / 100;
  lines.push(`НДС ${vatRate}%: ${som(vat)} (база — стоимость + пошлина)`
    + (vf.firm.length ? ' — освобождение по перечню ПКМ КР № 596' : '')
    + (!vf.firm.length && vf.cond.length ? '; условное освобождение: ' + vf.cond.map((x) => x.why).join('; ') : ''));
  const fee = c.customsFeeGoods(valueSom);
  lines.push(`Сбор за таможенные операции: ${som(fee)} (0,4% от таможенной стоимости, вилка 500–250 000 сом)`);
  lines.push(`Итого: ${som(duty.duty + vat + fee)}`);
  if (c.findExcise(digits).length) lines.push('Товар подакцизный: акциз в расчёт не включён — ставка зависит от вида и объёма (ст. 336 НК КР), и он увеличивает базу НДС.');
  const warns = c.calcWarnings(digits).map((w) => cardsToText(w.text).slice(0, 500)).filter(Boolean);
  if (warns.length) lines.push('Предупреждения калькулятора:\n' + warns.join('\n'));
  // Расчёт выше — по ставке ЕТТ. Действующая сноска может снижать её (часто до 0%
  // на срок), а начало срока привязано к вступлению решения в силу, которое по
  // тексту сноски не вычислить, — поэтому сноска приводится, а не применяется молча.
  const fns = footnotesFor(digits, date);
  if (fns.length) lines.push('ВНИМАНИЕ — к коду есть сноски ЕЭК, они могут менять ставку; расчёт выше их не учитывает:\n' + fns.join('\n'));
  return lines.join('\n');
}

let footnotes;
function footnotesDb() {
  const file = path.join(__dirname, '../../private/ett-footnotes.json');
  if (footnotes === undefined) footnotes = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  return footnotes;
}
// Сноски ЕЭК к коду (tools/build-ett-footnotes.js). К ставке — только действующие для
// Кыргызстана на дату: большинство из 124 сносок либо утратили силу, либо истекли в
// 2022–2024 годах, либо дают ставку только при ввозе в Россию; пересказ таких модель
// превращала бы в воду или, хуже, в неверную ставку.
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const OTHER_STATE = /ввозимых в (Российскую Федерацию|Республику Беларусь|Республику Армения|Республику Казахстан)/;
function footnotesFor(code, dateIso) {
  const db = footnotesDb();
  const entry = db && db.codes[code];
  if (!entry) return [];
  const today = dateIso || new Date().toISOString().slice(0, 10);
  const iso = (d) => d.split('.').reverse().join('-');
  const out = [];
  for (const n of entry.rate) {
    const t = db.rateNotes[n];
    if (!t || /утратило силу/.test(t)) continue;
    if (OTHER_STATE.test(t) && !/Кыргызск/.test(t)) continue;
    // Срок пишется и цифрами («по 31.12.2027»), и прописью («по 30 апреля 2025 г.»).
    const ends = [...t.matchAll(/по (\d\d\.\d\d\.\d{4}) включительно/g)].map((m) => iso(m[1]))
      .concat([...t.matchAll(/по (\d{1,2}) ([а-я]+) (\d{4}) г\.? включительно/g)].map((m) => {
        const mon = MONTHS.indexOf(m[2]) + 1;
        return mon ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}` : '9999';
      }));
    if (ends.length && ends.every((e) => e < today)) continue;
    out.push(`Сноска ЕЭК ${n}С к ставке ЕТТ: ${t}`);
  }
  for (const n of entry.name) {
    const t = db.nameNotes[n];
    if (t) out.push(`Сноска ЕЭК ${n}) к наименованию позиции: ${t.slice(0, 1500)}`);
  }
  return out;
}

// Пункт N раздела «Дополнительные примечания Евразийского экономического союза» группы.
function additionalNote(chapter, n) {
  const db = notesDb();
  const text = db && db.chapters[chapter] && db.chapters[chapter].notes;
  const at = text ? text.indexOf('Дополнительные примечания Евразийского') : -1;
  if (at < 0) return '';
  const item = text.slice(at).split('\n').find((l) => l.startsWith(n + '. '));
  return item ? item.slice(n.length + 2).slice(0, 3000) : '';
}

function groupNotes({ chapter } = {}) {
  const db = notesDb();
  const nn = String(chapter || '').replace(/\D/g, '').slice(0, 2).padStart(2, '0');
  const ch = db && db.chapters[nn];
  if (!ch) return `Примечаний к группе ${nn} нет.`;
  const sec = db.sections[ch.section];
  return clip([
    sec && sec.notes ? `Раздел ${ch.section}. ${sec.title}\nПримечания к разделу:\n${sec.notes}` : '',
    `Группа ${nn}. ${ch.title}\n${ch.notes || 'Примечаний к группе нет.'}`,
    `Источник: [ТН ВЭД ЕАЭС, группа ${nn}](${ch.url})`,
  ].filter(Boolean).join('\n\n'));
}

function tools() {
  const list = [{
    name: 'search_base',
    description: 'Поиск в базе CustomsAssistKG. Код ТН ВЭД (4–10 цифр) — все карточки мер: ставка ЕТТ, запреты, лицензирование, НКС, '
      + 'сертификация, ТР ЕАЭС, вет/фито/санконтроль, льготы по НДС, антидемпинг, квоты, ТРОИС, УСИР, устаревшие коды, предварительные решения. '
      + 'Наименование товара или бренд — список кандидатных кодов с полными наименованиями.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Код ТН ВЭД или короткое наименование (1–3 слова, как в ЕТТ)' },
        direction: { type: 'string', enum: ['im', 'ex', 'tr'], description: 'Направление: im — ввоз (по умолчанию), ex — вывоз, tr — транзит' },
        country: { type: 'string', description: 'Страна происхождения — название по-русски (Китай, Казахстан, ОАЭ)' },
        date: { type: 'string', description: 'Дата оформления YYYY-MM-DD, если названа' },
      },
      required: ['query'],
    },
  }, {
    name: 'calc_payments',
    description: 'Расчёт ввозных платежей (пошлина, НДС, сбор) по 10-значному коду — тем же расчётом, что калькулятор сайта, по курсу НБКР. '
      + 'Вызывай, когда пользователь назвал стоимость. Сам не считай.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '10-значный код ТН ВЭД' },
        value: { type: 'number', description: 'Таможенная стоимость в валюте' },
        currency: { type: 'string', enum: ['USD', 'EUR', 'CNY', 'RUB', 'KZT', 'СОМ'] },
        quantity: { type: 'number', description: 'Количество в единице специфической ставки (кг, шт, л, см³) — если ставка специфическая или комбинированная' },
        country: { type: 'string', description: 'Страна происхождения — название по-русски (Китай, Казахстан, ОАЭ)' },
        date: { type: 'string', description: 'Дата оформления YYYY-MM-DD' },
      },
      required: ['code', 'value', 'currency'],
    },
  }];
  if (notesDb()) list.push({
    name: 'group_notes',
    description: 'Официальные примечания к разделу и группе ТН ВЭД ЕАЭС. Вызывай, когда выбор кода зависит от примечаний (исключения, определения).',
    input_schema: { type: 'object', properties: { chapter: { type: 'string', description: 'Номер группы, 2 цифры' } }, required: ['chapter'] },
  });
  return list;
}

// Цены DeepSeek, $ за 1 млн токенов, в часы пик (api-docs.deepseek.com/quick_start/pricing,
// 16.09.2026). Вне пика — половина. Меняются — задать AI_PRICES в .env тем же JSON:
// стоимость пишется в журнал в момент вопроса, прошлые записи не пересчитываются.
const PRICES = Object.assign({
  flash: { cacheHit: 0.006, cacheMiss: 0.30, output: 1.20 },
  pro: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
}, process.env.AI_PRICES ? JSON.parse(process.env.AI_PRICES) : {});
// Пик — 01:00–04:00 и 06:00–10:00 UTC с понедельника по пятницу.
function isPeak(d) {
  const day = d.getUTCDay(), h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}
function roundCost(u, model, at = new Date()) {
  if (!u) return 0;
  const p = PRICES[/pro/i.test(String(model || MODEL)) ? 'pro' : 'flash'];
  const k = isPeak(at) ? 1 : 0.5;
  return k * ((u.input_tokens || 0) * p.cacheMiss + (u.cache_read_input_tokens || 0) * p.cacheHit + (u.output_tokens || 0) * p.output) / 1e6;
}

async function callModel(messages, toolChoice) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.AI_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4000, tools: tools(), messages,
      // deepseek-v4-pro по умолчанию «думает», а в этом режиме принудительный
      // tool_choice отвергается (400). flash параметр принимает без последствий.
      thinking: { type: 'disabled' },
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      // Напоминание в самом конце: flash-модель лучше держит последние строки промта,
      // и без него в ответах оставались «в базе не приведено», «не требуется».
      system: PROMPT + `\n\n---\nСегодня ${new Date().toISOString().slice(0, 10)}.\n`
        + 'Перед отправкой удали из ответа каждую строку о том, чего нет, что не найдено, не требуется или не применяется, и каждую меру, не относящуюся к направлению перемещения.',
    }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`AI API ${res.status}: ${data.error?.message || 'unknown'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Десятизначные коды в тексте — в любой записи: 8517130000 или 8517 13 000 0.
const CODE_RE = /(?<!\d)(\d{4})[  ]?(\d{2})[  ]?(\d{3})[  ]?(\d)(?!\d)/g;
function codesIn(text) {
  const set = new Set();
  for (const m of String(text).matchAll(CODE_RE)) set.add(m[1] + m[2] + m[3] + m[4]);
  return set;
}

// Ссылка в ответе, которой не было в выдаче, — выдуманный адрес («[ЕТТ](https://customs.gov.kg)»).
// Такая ссылка становится обычным текстом; адрес из выдачи остаётся ссылкой.
function keepKnownLinks(answer, toolText) {
  return answer.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) => (toolText.includes(url.split('#')[0]) ? m : text));
}

async function runTool(u) {
  if (u.name === 'search_base') return searchBase(u.input);
  if (u.name === 'calc_payments') return calcPayments(u.input);
  if (u.name === 'group_notes') return groupNotes(u.input);
  return 'Неизвестный инструмент.';
}

// history — [{role:'user'|'assistant', content:string}], последняя реплика пользователя.
// onStep получает шаги для экрана: {tool, input}.
async function ask(history, { onStep = () => {}, images = [] } = {}) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  // Фото инвойса — к последнему вопросу, перед текстом: модель сначала видит документ.
  if (images.length) {
    const last = messages[messages.length - 1];
    last.content = [...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
      { type: 'text', text: last.content }];
  }
  const searched = [];
  const seen = new Set();
  const seenText = [];
  for (const m of history) for (const code of codesIn(m.content)) seen.add(code);
  const usage = { input: 0, output: 0, cacheRead: 0, costUsd: 0 };
  let verified = false;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // Первый раунд — только поиск: ответить, не заглянув в базу, модель не может.
    // Именно type:'tool' с именем: DeepSeek молча игнорирует type:'any' (проверено
    // 16.09.2026 — на «ping» пришёл текст без вызова), а именованный выбор соблюдает.
    // Последний раунд — без инструментов, чтобы ответ пришёл в любом случае.
    const choice = round === 0 ? { type: 'tool', name: 'search_base' } : (round === MAX_TOOL_ROUNDS ? { type: 'none' } : null);
    const data = await callModel(messages, choice);
    usage.input += data.usage?.input_tokens || 0;
    usage.output += data.usage?.output_tokens || 0;
    usage.cacheRead += data.usage?.cache_read_input_tokens || 0;
    usage.costUsd += roundCost(data.usage, data.model);
    const content = data.content || [];
    const uses = content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      const answer = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || 'Не удалось получить ответ.';
      // Код в ответе, которого не было ни в вопросе, ни в выдаче инструментов,
      // модель взяла из памяти. Один раз просим проверить; если снова — помечаем.
      const unverified = [...codesIn(answer)].filter((code) => !seen.has(code));
      if (unverified.length && !verified && round < MAX_TOOL_ROUNDS) {
        verified = true;
        onStep({ tool: 'verify', input: { codes: unverified } });
        messages.push({ role: 'assistant', content: answer });
        messages.push({ role: 'user', content: `Служебная проверка: коды ${unverified.join(', ')} не встречались в результатах инструментов. `
          + 'Проверь каждый через search_base или убери его. Затем верни исправленный ответ целиком, без упоминания этой проверки.' });
        continue;
      }
      return { answer: keepKnownLinks(answer, seenText.join('\n')), searched, usage, unverified };
    }
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const u of uses) {
      onStep({ tool: u.name, input: u.input || {} });
      let result;
      try { result = await runTool(u); } catch (e) { console.error('assistant tool', u.name, e); result = 'Ошибка инструмента.'; }
      if (u.name === 'search_base') searched.push(String(u.input?.query || ''));
      // «Проверен» только тот код, который вернул инструмент: запрос несуществующего
      // кода сам по себе его не подтверждает.
      for (const code of codesIn(result)) seen.add(code);
      seenText.push(result);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: result });
    }
    messages.push({ role: 'user', content: results });
  }
}

module.exports = { ask, searchBase, calcPayments, groupNotes, cardsToText, splitDivs, codesIn, keepKnownLinks, checker, roundCost };
