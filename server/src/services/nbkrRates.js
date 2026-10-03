const https = require('https');
const ops = require('./ops');

// Курс НБКР меняется раз в сутки (слово владельца, 03.10.2026): хватает одного обновления сразу после полуночи по Бишкеку — курс нового
// дня НБКР публикует накануне вечером, и в 00:02 daily.xml уже несёт его. Часовой опрос (до 03.10.2026) был лишним: 24 запроса в сутки
// ради одного нужного, и каждый обрыв nbkr.kg попадал в журнал. Зато обрыв в 00:02 не должен оставить сутки без курса дня, поэтому пока
// запрос не удаётся — повтор каждые 15 минут, а если ответ пришёл, но НБКР ещё не сменил дату (курса на сегодня в истории нет), — раз в час.
const REFRESH_AFTER_MIDNIGHT_MS = 2 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
const RETRY_NO_RATE_FOR_TODAY_MS = 60 * 60 * 1000;
// Без таймаута зависший сокет оставляет промис refresh() навсегда
// неразрешённым; поскольку все последующие вызовы возвращают этот же промис
// (см. переменную refreshing ниже), обновление курса после этого не
// происходит уже никогда — до перезапуска процесса, — а getRates() ждёт его
// вместе с запросом пользователя. Таймаут гарантирует, что промис всегда
// завершится, и это и есть настоящее исправление, а не сброс refreshing.
const FETCH_TIMEOUT_MS = 15 * 1000;

// Курсы, которые есть в daily.xml НБКР. usd/eur продублированы в корне ответа
// (кроме rates) — на них уже завязан фронт, и ломать их ради красоты незачем.
const CURRENCIES = ['USD', 'EUR', 'CNY', 'RUB', 'KZT'];

let cache = null; // последний полученный: { date, usd, eur, rates: { USD, EUR, CNY, RUB, KZT } }
// Курс, действующий в день, — а не последний полученный. НБКР публикует курс на завтра уже вечером (02.10.2026 в 17:40 по Бишкеку
// daily.xml нёс Date="03.10.2026", параметр ?date= он игнорирует), а таможня берёт курс на день регистрации декларации: с вечера
// до полуночи калькулятор считал бы по завтрашнему курсу. Поэтому помнятся последние десять полученных курсов, и getRates() отдаёт
// тот, чья дата — наибольшая из не позже нужного дня (по умолчанию сегодня по Бишкеку). Первый запуск вечером, когда вчерашнего
// курса ещё нет, отдаёт имеющийся, а не отказ. История лежит и в файле на диске.
const HISTORY_MAX = 10;
let history = [];
const isoOf = (d) => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(d || '')); return m ? m[3] + '-' + m[2] + '-' + m[1] : null; };
const bishkekToday = (now = Date.now()) => new Date(now + 6 * 3600e3).toISOString().slice(0, 10);
function pushHistory(list, entry) {
  return list.filter((r) => r.date !== entry.date).concat(entry)
    .sort((a, b) => String(isoOf(a.date)).localeCompare(String(isoOf(b.date)))).slice(-HISTORY_MAX);
}
function effective(forIso = bishkekToday()) {
  if (!cache) return null;
  const all = history.length ? history : [cache];
  let pick = null;
  for (const r of all) {
    const iso = isoOf(r.date);
    if (iso && iso <= forIso && (!pick || iso > isoOf(pick.date))) pick = r;
  }
  return pick || all[0];
}
// Последний удачный ответ НБКР лежит на диске (server/var/nbkr-rates.json, каталог состояния — как у счётчиков перебора и разбора
// находок). Без него перезапуск службы — а перезапуск это каждая выкладка и каждое обновление ОС — при недоступном nbkr.kg оставлял
// калькулятор и помощника без курсов до возвращения сайта. Файл нужен только как запасной: сперва всегда спрашивается НБКР, и курс
// с диска берётся, лишь когда запрос не удался и в памяти ничего нет; он виден как обычный — с датой НБКР («курс НБКР на 01.10.2026»).
// Курсы публичные, личных данных в файле нет. Файл читает и пишет только служба, запущенная через init() (index.js под
// require.main === module), как и счётчики перебора: тесты, дашборд-сборщики и require из скриптов его не касаются — иначе
// каждый прогон тестов с настоящим getRates() оставлял бы server/var/nbkr-rates.json в рабочем дереве (02.10.2026, ветка правил).
// Тест файла включает запись явно: setPersist(true).
const STATE_FILE = 'nbkr-rates.json';
let persist = false;
let fromDisk = false;
// С какого момента запросы к НБКР подряд не удаются (null — последний удался): по нему services/health.js решает, пора ли писать
// администраторам. Запасной курс с диска сам по себе тревоги не поднимает — он только не даёт калькулятору остановиться.
let failingSince = null;
function saveRates() {
  if (!persist) return;
  try {
    ops.writeJson(STATE_FILE, { v: 2, savedAt: new Date().toISOString(), ...cache, history });
  } catch (err) {
    console.error('nbkr-rates: не удалось сохранить курс на диск', err.message);
  }
}
function loadRates() {
  if (!persist) return null;
  const j = ops.readJson(STATE_FILE);
  const ok = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
  const entry = (x) => {
    if (!x || !x.rates || !ok(x.rates.USD) || !ok(x.rates.EUR) || !ok(x.usd) || !ok(x.eur)) return null;
    const rates = {};
    for (const c of CURRENCIES) if (ok(x.rates[c])) rates[c] = x.rates[c];
    return { date: typeof x.date === 'string' ? x.date : null, usd: x.usd, eur: x.eur, rates };
  };
  if (!j || (j.v !== 1 && j.v !== 2)) return null;
  const latest = entry(j);
  if (!latest) return null;
  let list = [];
  if (j.v === 2 && Array.isArray(j.history)) for (const h of j.history.slice(-HISTORY_MAX)) { const e = entry(h); if (e && isoOf(e.date)) list = pushHistory(list, e); }
  return { latest, history: pushHistory(list, latest) };
}
let refreshing = null;
// Когда курс в последний раз обновился и чем кончилась последняя неудача — для
// дашборда администраторов (routes/dash.js): курс двухдневной давности при живом
// процессе означает, что nbkr.kg не отвечает, и это должно быть видно.
let updatedAt = null;
let lastError = null; // { at, message }

function fetchXml() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      'https://www.nbkr.kg/XML/daily.xml',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: FETCH_TIMEOUT_MS },
      (res) => {
        // Страница ошибки (404/5xx) — это не XML: без этой проверки она молча
        // не распарсится и кэш останется пустым без единого следа в логах.
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('nbkr.kg timed out after ' + FETCH_TIMEOUT_MS + 'ms')));
    req.on('error', reject);
  });
}

// В daily.xml у каждой валюты есть <Nominal>: сейчас у всех пяти он равен 1,
// но у НБКР он исторически бывал и 10, и 100 (например, для рубля и тенге),
// поэтому делим на него, а не полагаемся на текущее значение.
function parseRate(xml, isoCode) {
  const re = new RegExp(
    `<Currency ISOCode="${isoCode}">[\\s\\S]*?<Nominal>(\\d+)</Nominal>[\\s\\S]*?<Value>([\\d,]+)</Value>`
  );
  const m = xml.match(re);
  if (!m) return null;
  const nominal = parseInt(m[1], 10) || 1;
  const value = parseFloat(m[2].replace(',', '.'));
  return value ? value / nominal : null;
}

// Источник: https://www.nbkr.kg/XML/daily.xml — официальный ежедневный курс
// Нацбанка КР, простой статический XML без CORS-заголовков (проверено), поэтому
// прокси нужен, но, в отличие от классификатора ЕАЭС, кэшировать на диск не нужно —
// файл сам весит меньше 1 КБ, дешевле просто перезапрашивать его.
let historyLoaded = false;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    // История с диска подхватывается до первого ответа (один раз за жизнь процесса). Раньше с диска читалось только когда запрос не удался,
    // а удавшийся после перезапуска затирал файл одним днём — и вечером, когда daily.xml уже несёт завтрашний курс, служба отдавала его
    // вместо сегодняшнего (найдено 04.10.2026 при выкладке расписания: файл вместо двух дней остался с одним). Теперь ответ только дописывается.
    if (persist && !historyLoaded) {
      historyLoaded = true;
      const d = loadRates();
      if (d) history = d.history;
    }
    try {
      const xml = await fetchXml();
      const dateMatch = xml.match(/Date="([\d.]+)"/);
      const rates = {};
      for (const code of CURRENCIES) {
        const v = parseRate(xml, code);
        if (v) rates[code] = v;
      }
      // Доллар и евро — обязательный минимум: если их нет, разобрался не тот
      // документ (страница ошибки, смена формата), и кэш лучше не трогать.
      if (rates.USD && rates.EUR) {
        cache = { date: dateMatch ? dateMatch[1] : null, usd: rates.USD, eur: rates.EUR, rates };
        if (isoOf(cache.date)) history = pushHistory(history, cache);
        updatedAt = new Date().toISOString();
        lastError = null;
        failingSince = null;
        fromDisk = false;
        saveRates();
      } else {
        lastError = { at: new Date().toISOString(), message: 'daily.xml без USD/EUR' };
        failingSince = failingSince || Date.now();
      }
    } catch (err) {
      lastError = { at: new Date().toISOString(), message: err.message };
      failingSince = failingSince || Date.now();
      console.error('nbkr-rates: refresh failed', err.message);
    } finally {
      // Запрос не удался и в памяти пусто: последний удачный курс с диска вместо «курсы недоступны».
      if (!cache) {
        const d = loadRates();
        if (d) {
          cache = d.latest;
          history = d.history;
          fromDisk = true;
          console.warn('nbkr-rates: nbkr.kg не отвечает, взят курс с диска от ' + (d.latest.date || 'неизвестной даты'));
        }
      }
      refreshing = null;
    }
  })();
  return refreshing;
}

// forIso — день, на который нужен курс (YYYY-MM-DD; по умолчанию сегодня по Бишкеку).
async function getRates(forIso) {
  if (!cache) await refresh();
  return effective(forIso);
}

// Через сколько миллисекунд обновлять курс в следующий раз. Запрос не удался — через 15 минут (последний удачный курс с диска или из
// памяти тем временем служит, а тревога health.js поднимается только после суток неудач подряд). Запрос удался, но курса на сегодня в
// истории нет (НБКР ещё не сменил дату) — через час. Иначе — на 00:02 следующих суток по Бишкеку (UTC+6, перехода на летнее время нет).
function nextRefreshInMs(now = Date.now()) {
  if (failingSince) return RETRY_AFTER_FAILURE_MS;
  const today = bishkekToday(now);
  const haveToday = history.some((r) => isoOf(r.date) === today) || (cache && isoOf(cache.date) === today);
  if (!haveToday) return RETRY_NO_RATE_FOR_TODAY_MS;
  const DAY = 24 * 3600e3, local = now + 6 * 3600e3;
  let at = Math.floor(local / DAY) * DAY + REFRESH_AFTER_MIDNIGHT_MS;
  if (at <= local) at += DAY;
  return at - local;
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => refresh().then(schedule, schedule), nextRefreshInMs());
}

function init() {
  persist = true;
  refresh().then(schedule, schedule); // при запуске — всегда сразу (выкладка — это перезапуск), дальше раз в сутки после полуночи
}

function status() {
  return { date: cache ? cache.date : null, usd: cache ? cache.usd : null, eur: cache ? cache.eur : null, effectiveDate: effective() ? effective().date : null, updatedAt, lastError, fromDisk, failingSince: failingSince ? new Date(failingSince).toISOString() : null };
}

module.exports = { init, getRates, refresh, status, nextRefreshInMs, setPersist: (v) => { persist = !!v; } };
