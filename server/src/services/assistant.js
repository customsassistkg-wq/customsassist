// AI-помощник: модель DeepSeek через совместимый с Anthropic API, но отвечает
// она по нашей базе. База — это server/private/checker.js, тот же файл, что
// получает браузер; здесь он исполняется в vm, и инструмент search_base
// вызывает тот же render(), что рисует карточки на сайте. Поэтому модель видит
// ровно то, что увидел бы пользователь, а не пересказ базы, который пришлось
// бы держать в согласии с ~40 функциями findX().
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const classDecisions = require('./classDecisions');

const CHECKER = path.join(__dirname, '../../private/checker.js');
const PROMPT = fs.readFileSync(path.join(__dirname, '../assistant-prompt.md'), 'utf8');
const API_URL = (process.env.AI_BASE_URL || 'https://api.deepseek.com/anthropic').replace(/\/+$/, '') + '/v1/messages';
const MODEL = process.env.AI_MODEL || 'deepseek-chat';
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_CHARS = 40000; // полная выдача по коду — до ~31 тыс. знаков; 14 тыс. отрезали сертификацию

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
    + '\nthis.__ai={render,lkCountry,lkPrefRates,ETT_DB};').runInContext(sb);
  ctx = { ...sb.__ai, box: el('aiBox') };
  return ctx;
}

// Карточка → текст. Отчёт о сверке (audit-body) — это 2–3 тыс. знаков о том,
// как сверялась база; модели он только съедает окно, статус и дата остаются.
function cardsToText(html) {
  return html
    .replace(/<div class="audit-body">[\s\S]*?<\/div>/g, '')
    .replace(/<button[\s\S]*?<\/button>/g, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '$2 ($1)')
    .replace(/<(br|\/div|\/li|\/tr|\/p|\/summary|\/h\d)[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function searchBase({ query, country, date } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return 'Пустой запрос.';
  const c = checker();
  c.box.innerHTML = '';
  c.render(q, 'aiBox');
  // Короткие вставки — впереди карточек: длинную выдачу обрезаем с хвоста.
  const extra = [];
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 4 && digits.length === q.replace(/\s/g, '').length) {
    if (country && digits.length === 10) {
      const cty = c.lkCountry(country);
      const row = c.ETT_DB.find((r) => r[0] === digits);
      if (cty && row) {
        const rates = c.lkPrefRates(digits, row[3], cty, date);
        extra.push(`Страна происхождения: ${cty.name}`
          + (cty.eaeu ? ' — государство — член ЕАЭС, ЕТТ во взаимной торговле не применяется.' : '')
          + (rates.length ? '\n' + rates.map((r) => `Ставка ${r.rate}: ${r.basis}${r.pending ? ` (применяется с ${r.pending})` : ''}`).join('\n')
            : (cty.eaeu ? '' : '\nПреференций для этой страны в базе нет — применяется ставка ЕТТ.')));
      }
    }
    const cd = classDecisions.search(digits, 5);
    if (cd.total) {
      extra.push(`Предварительные решения по классификации (справочник НСИ ЕАЭС №1999), всего ${cd.total}:\n`
        + cd.results.map((r) => `${r.code} — ${r.description} (${r.country}): ${String(r.justification || "").slice(0, 400)}`).join('\n'));
    }
  }
  let out = [...extra, cardsToText(c.box.innerHTML)].filter(Boolean).join('\n\n');
  if (out.length > MAX_TOOL_CHARS) out = out.slice(0, MAX_TOOL_CHARS) + '\n… (выдача обрезана — уточните код)';
  return out || 'В базе ничего не найдено.';
}

const TOOLS = [{
  name: 'search_base',
  description: 'Поиск в базе CustomsAssistKG. Принимает код ТН ВЭД (4–10 цифр) или наименование товара/бренд/страну. '
    + 'По коду возвращает все карточки: ставку ЕТТ, запреты, лицензирование, НКС, сертификацию, ТР ЕАЭС, ветеринарный/фитосанитарный/санитарный контроль, '
    + 'льготы по НДС, антидемпинг, квоты, ТРОИС, устаревшие коды и предварительные решения. По наименованию — список кандидатных кодов.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Код ТН ВЭД или короткое наименование (1–3 слова, как в ЕТТ)' },
      country: { type: 'string', description: 'Страна происхождения — для преференциальной ставки (только с 10-значным кодом)' },
      date: { type: 'string', description: 'Дата оформления YYYY-MM-DD, если пользователь её назвал' },
    },
    required: ['query'],
  },
}];

async function callModel(messages, forceTool) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.AI_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4000, tools: TOOLS, messages,
      // deepseek-v4-pro по умолчанию «думает», а в этом режиме принудительный
      // tool_choice отвергается (400). flash параметр принимает без последствий.
      thinking: { type: 'disabled' },
      // Первый раунд — только поиск: ответить, не заглянув в базу, модель не может.
      // Именно type:'tool' с именем: DeepSeek молча игнорирует type:'any' (проверено
      // 16.09.2026 — на «ping» пришёл текст без вызова), а именованный выбор соблюдает.
      ...(forceTool ? { tool_choice: { type: 'tool', name: 'search_base' } } : {}),
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

// history — [{role:'user'|'assistant', content:string}], последняя реплика пользователя.
async function ask(history) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const searched = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data = await callModel(messages, round === 0);
    const uses = (data.content || []).filter((b) => b.type === 'tool_use');
    if (!uses.length || round === MAX_TOOL_ROUNDS) {
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { answer: text || 'Не удалось получить ответ.', searched };
    }
    messages.push({ role: 'assistant', content: data.content });
    messages.push({ role: 'user', content: uses.map((u) => {
      let result;
      try { result = u.name === 'search_base' ? searchBase(u.input) : 'Неизвестный инструмент.'; }
      catch (e) { console.error('assistant search_base', e); result = 'Ошибка поиска в базе.'; }
      if (u.name === 'search_base') searched.push(String(u.input?.query || ''));
      return { type: 'tool_result', tool_use_id: u.id, content: result };
    }) });
  }
}

module.exports = { ask, searchBase, cardsToText };
