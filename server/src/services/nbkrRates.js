const https = require('https');

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // раз в час проверяем, не сменилась ли дата курса
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

let cache = null; // { date, usd, eur, rates: { USD, EUR, CNY, RUB, KZT } }
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
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
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
        updatedAt = new Date().toISOString();
        lastError = null;
      } else {
        lastError = { at: new Date().toISOString(), message: 'daily.xml без USD/EUR' };
      }
    } catch (err) {
      lastError = { at: new Date().toISOString(), message: err.message };
      console.error('nbkr-rates: refresh failed', err.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function getRates() {
  if (!cache) await refresh();
  return cache;
}

function init() {
  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

function status() {
  return { date: cache ? cache.date : null, usd: cache ? cache.usd : null, eur: cache ? cache.eur : null, updatedAt, lastError };
}

module.exports = { init, getRates, refresh, status };
