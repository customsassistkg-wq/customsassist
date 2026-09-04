const https = require('https');

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // раз в час проверяем, не сменилась ли дата курса
// Без таймаута зависший сокет оставляет промис refresh() навсегда
// неразрешённым; поскольку все последующие вызовы возвращают этот же промис
// (см. переменную refreshing ниже), обновление курса после этого не
// происходит уже никогда — до перезапуска процесса, — а getRates() ждёт его
// вместе с запросом пользователя. Таймаут гарантирует, что промис всегда
// завершится, и это и есть настоящее исправление, а не сброс refreshing.
const FETCH_TIMEOUT_MS = 15 * 1000;

let cache = null; // { date, usd, eur }
let refreshing = null;

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

function parseRate(xml, isoCode) {
  const re = new RegExp(`<Currency ISOCode="${isoCode}">[\\s\\S]*?<Value>([\\d,]+)</Value>`);
  const m = xml.match(re);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
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
      const usd = parseRate(xml, 'USD');
      const eur = parseRate(xml, 'EUR');
      if (usd && eur) {
        cache = { date: dateMatch ? dateMatch[1] : null, usd, eur };
      }
    } catch (err) {
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

module.exports = { init, getRates, refresh };
