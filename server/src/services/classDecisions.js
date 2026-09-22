const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'class-decisions.json');
const DICTIONARY_CODE = '1999';
const PAGE_SIZE = 1000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Тот же таймаут и по той же причине, что в services/nbkrRates.js: зависший
// сокет иначе навсегда оставляет refreshing неразрешённым и выключает
// обновление справочника до перезапуска процесса.
const FETCH_TIMEOUT_MS = 30 * 1000;
// Страховка от бесконечной постраничной выкачки: если источник вдруг начнёт
// игнорировать offset и отдавать одну и ту же страницу, цикл в
// fetchAllFromSource() иначе крутился бы вечно, накапливая строки в памяти.
const MAX_PAGES = 100;

let items = [];
let fetchedAt = null;
let refreshing = null;

function postJson(pathName, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'nsi.eaeunion.org',
        path: pathName,
        method: 'POST',
        timeout: FETCH_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent': 'Mozilla/5.0',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('nsi.eaeunion.org timed out after ' + FETCH_TIMEOUT_MS + 'ms')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fetchAllFromSource() {
  const date = new Date().toISOString().slice(0, 10);
  const result = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await postJson(`/portal/api/dictionaries/${DICTIONARY_CODE}/get-list-data`, {
      date,
      offset,
      limit: PAGE_SIZE,
      filter: [{ code: 'searchText', value: '', conditionType: 'like' }],
      sort: [],
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const d = row.data || {};
      if (!d.CodeTNVED) continue;
      result.push([d.CodeTNVED, d.Description || '', (d.Country && d.Country.name) || '', d.Justification || '']);
    }
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return result;
}

function loadFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    items = raw.items || [];
    fetchedAt = raw.fetchedAt || null;
  } catch (err) {
    items = [];
    fetchedAt = null;
  }
}

function saveToDisk() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ fetchedAt, items }));
  fs.renameSync(tmp, DATA_FILE);
}

// Источник: nsi.eaeunion.org, справочник №1999 («Сборник принятых предварительных
// решений таможенных органов государств – членов ЕАЭС по классификации товаров») —
// незадокументированный внутренний REST-эндпоинт портала НСИ ЕАЭС, обнаруженный
// вручную (см. session.md). У него нет CORS и он не расcчитан на запрос от каждого
// клиента при каждом поиске, поэтому держим локальную копию и обновляем её раз в
// сутки одним запросом с сервера, а не проксируем живой запрос на каждый ввод кода.
let lastError = null; // { at, message } — последняя неудача обновления, для дашборда администраторов
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const fresh = await fetchAllFromSource();
      if (fresh.length > 0) {
        items = fresh;
        fetchedAt = new Date().toISOString();
        lastError = null;
        saveToDisk();
        console.log(`class-decisions: refreshed, ${items.length} items`);
      }
    } catch (err) {
      lastError = { at: new Date().toISOString(), message: err.message };
      console.error('class-decisions: refresh failed', err.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function normalizeCode(s) {
  return String(s || '').replace(/\D/g, '');
}

// Тот же принцип "код запроса — префикс кода записи ИЛИ наоборот", что и в
// findX()-функциях самого tnved_checker.html (см. CLAUDE.md), чтобы короткий
// код товарной позиции тоже находил вложенные в него более длинные коды.
function search(query, limit = 30) {
  const qn = normalizeCode(query);
  if (!qn) return { total: 0, results: [] };
  let total = 0;
  const results = [];
  for (const [code, description, country, justification] of items) {
    const cn = normalizeCode(code);
    if (cn.startsWith(qn) || qn.startsWith(cn)) {
      total++;
      if (results.length < limit) results.push({ code, description, country, justification });
    }
  }
  return { total, results };
}

function init() {
  loadFromDisk();
  const isStale = !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > REFRESH_INTERVAL_MS;
  if (items.length === 0 || isStale) refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

// Состояние справочника для дашборда администраторов (routes/dash.js).
function status() {
  return { count: items.length, fetchedAt, lastError };
}

module.exports = { init, search, refresh, status };
