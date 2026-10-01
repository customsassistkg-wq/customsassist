// node tools/link-check.js [--only=portal|registry|other] [--strict]
//
// Живы ли внешние адреса, на которые ссылается база (server/private/base.js и checker.js), и верны ли ссылки на реестр НПА.
// Нужна сеть; ничего не пишет. Код выхода 1 — найден мёртвый адрес или цитируемая редакция не последняя; 0 — иначе
// (зависания и «неизвестно» только печатаются; с --strict они тоже дают 1).
//
// Три части, у каждой свой темп — порталы ЕЭК при нескольких запросах сразу отдают страницы по 16 КБ в минуту (01.10.2026):
//   portal   docs.eaeunion.org — только заголовки ответа, три потока, пауза 0,3 с. 200 — жива; 301 на карточку
//            /documents/N/N/ или /docs/ru-ru/… — старый адрес, норма; 404/410 — мёртвая; тайм-аут — «неизвестно».
//   registry cbd.minjust.gov.kg — SPA, поэтому через API карточек (раз в 1,2 с): редакция есть в карточке и она последняя.
//   other    прочие хосты (eec.eaeunion.org, customs.gov.kg, sti.gov.kg, …) — два потока, пауза 0,7 с. Перенаправление на
//            страницу ошибки (…/error404) считается смертью адреса: так отвалилась страница счётчика квоты ГТС.
//
// Известные не-дефекты вписаны в KNOWN ниже вместе с причиной; всё, чего там нет, — находка.
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const tls = require('node:tls');

const ROOT = path.join(__dirname, '..');
const FILES = ['server/private/base.js', 'server/private/checker.js'];
const EXTRA_CA = fs.readFileSync(path.join(ROOT, 'server/certs/RapidSSLTLSRSACAG1.crt.pem'), 'utf8'); // gov.kg отдаёт цепочку без промежуточного сертификата
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Не дефекты: адрес → причина. Всё остальное, что не 200/206, печатается как находка.
const KNOWN = [
  [/^https:\/\/cites\.org\//, 'отвечает скриптам 403, в браузере открывается'],
  [/^https:\/\/sti\.gov\.kg\/section\/view-pdf/, 'страница-просмотрщик, а не сам PDF'],
];
// Акты реестра, помеченные «Утратил силу», но оставленные в базе сознательно (docs/source-audit.md, «Checked and known, not gaps»).
const KNOWN_REPEALED = new Set(['4-4095']);

function collect() {
  const urls = new Set();
  for (const f of FILES) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of t.matchAll(/https?:\/\/[^\s'"`<>\\)\]}]+/g)) {
      // «'https://…/psn'+nn+'.pdf'» — это начало адреса, который собирает код, а не адрес: пропускаем
      if (/^['"`]\s*\+/.test(t.slice(m.index + m[0].length, m.index + m[0].length + 6))) continue;
      // http:// в тексте базы — ссылка на сайт, который сам перенаправляет на https; проверяем https
      urls.add(m[0].replace(/[.,;:]+$/, '').replace(/^http:/, 'https:'));
    }
  }
  return [...urls];
}

function head(u, { timeout = 30000, range = false } = {}) {
  return new Promise((resolve) => {
    const U = new URL(u);
    const t0 = Date.now();
    const req = https.request({ host: U.hostname, path: U.pathname + U.search, family: 4, method: 'GET', timeout, ca: tls.rootCertificates.concat(EXTRA_CA),
      headers: { 'User-Agent': UA, Referer: `https://${U.hostname}/`, 'Accept-Encoding': 'identity', ...(range ? { Range: 'bytes=0-2047' } : {}) } }, (res) => {
      const out = { u, code: res.statusCode, loc: res.headers.location, type: res.headers['content-type'] || '', ms: Date.now() - t0 };
      if (!range) { res.destroy(); return resolve(out); }
      const ch = []; let n = 0;
      res.on('data', (c) => { ch.push(c); n += c.length; if (n > 4096) res.destroy(); });
      const done = () => resolve({ ...out, head: Buffer.concat(ch).toString('latin1', 0, 8) });
      res.on('end', done); res.on('close', done);
    });
    req.on('timeout', () => { req.destroy(); resolve({ u, code: 'timeout' }); });
    req.on('error', (e) => resolve({ u, code: 'err ' + e.code }));
    req.end();
  });
}

async function pool(items, workers, pause, fn) {
  const out = []; let i = 0;
  const run = async () => { for (;;) { const k = i++; if (k >= items.length) return; out.push(await fn(items[k])); if (pause) await sleep(pause); } };
  await Promise.all(Array.from({ length: workers }, run));
  return out;
}

const known = (u) => (KNOWN.find(([re]) => re.test(u)) || [])[1];

async function checkPortal(urls) {
  const list = urls.filter((u) => /^https:\/\/docs\.eaeunion\.org\//.test(u));
  const res = await pool(list, 3, 300, (u) => head(u, { timeout: 30000 }));
  const by = {}; for (const r of res) by[r.code] = (by[r.code] || 0) + 1;
  console.log(`правовой портал: ${res.length} адресов`, JSON.stringify(by));
  let dead = 0, unknown = 0;
  for (const r of res) {
    if (r.code === 200) continue;
    if ((r.code === 301 || r.code === 302) && /\/documents\/\d+\/\d+\/?$|\/docs\/ru-ru\//.test(r.loc || '')) continue;
    if (r.code === 'timeout' || /^err/.test(String(r.code))) { unknown++; console.log('  неизвестно', r.code, r.u); continue; }
    dead++; console.log('  МЁРТВЫЙ', r.code, r.loc || '', r.u);
  }
  return { dead, unknown };
}

async function checkRegistry(urls) {
  const docs = new Map();
  for (const u of urls) {
    const m = u.match(/^https:\/\/cbd\.minjust\.gov\.kg\/([\w-]+)\/edition\/(\d+)\/ru/); if (!m) continue;
    (docs.get(m[1]) || docs.set(m[1], new Set()).get(m[1])).add(m[2]);
  }
  const key = (x) => String(x.nameRus || '').split('.').reverse().join('');
  const api = (p) => new Promise((resolve) => {
    const r = https.request({ host: 'cbd.minjust.gov.kg', path: p, method: 'GET', family: 4, timeout: 40000, headers: { 'User-Agent': UA, Referer: 'https://cbd.minjust.gov.kg/', Origin: 'https://cbd.minjust.gov.kg', Accept: 'application/json' } }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', (e) => resolve({ status: 'err ' + e.code, body: '' })); r.end();
  });
  console.log(`реестр НПА: ${docs.size} карточек в ссылках`);
  let dead = 0, unknown = 0;
  for (const [code, eds] of docs) {
    let d = await api(`/api/v1/GetDocument?documentCode=${code}&lang=ru`);
    if (d.status === 429) { await sleep(5000); d = await api(`/api/v1/GetDocument?documentCode=${code}&lang=ru`); }
    await sleep(1200);
    let j = null; try { j = JSON.parse(d.body); } catch (e) { /* ниже */ }
    if (!j) { unknown++; console.log('  неизвестно: карточка не ответила', code, d.status); continue; }
    const list = (j.editions || []).slice().sort((a, b) => (key(a) < key(b) ? -1 : 1));
    const last = list[list.length - 1];
    for (const ed of eds) {
      if (!list.some((e) => String(e.id) === ed)) { dead++; console.log('  МЁРТВАЯ ссылка: редакции нет в карточке', code, ed); }
      else if (last && String(last.id) !== ed) { dead++; console.log('  НЕ ПОСЛЕДНЯЯ редакция', code, ed, '→', last.id, 'от', last.nameRus); }
    }
    const status = (j.status || {}).nameRus;
    if (status === 'Утратил силу' && !KNOWN_REPEALED.has(code)) { dead++; console.log('  УТРАТИЛ СИЛУ', code, String(j.nameRus || '').replace(/\s+/g, ' ').slice(0, 100)); }
  }
  return { dead, unknown };
}

async function checkOther(urls) {
  const list = urls.filter((u) => !/^https:\/\/(docs\.eaeunion\.org|cbd\.minjust\.gov\.kg)\//.test(u) && /^https:/.test(u));
  const res = await pool(list, 2, 700, async (u) => {
    let r = await head(u, { timeout: 45000, range: true });
    if (r.code === 'timeout' || /^err/.test(String(r.code))) { await sleep(3000); r = await head(u, { timeout: 45000, range: true }); }
    return r;
  });
  console.log(`прочие хосты: ${res.length} адресов`);
  let dead = 0, unknown = 0;
  for (const r of res) {
    if (r.code === 200 || r.code === 206) {
      if (/\.pdf$/i.test(r.u) && !known(r.u) && !/^%PDF/.test(r.head || '')) { dead++; console.log('  НЕ PDF', r.u, JSON.stringify(r.head)); }
      continue;
    }
    const why = known(r.u); if (why) { console.log('  известно:', r.code, why, '|', r.u.slice(0, 90)); continue; }
    if (r.code === 'timeout' || /^err/.test(String(r.code))) { unknown++; console.log('  неизвестно', r.code, r.u); continue; }
    dead++; console.log('  МЁРТВЫЙ', r.code, r.loc || '', r.u);
  }
  return { dead, unknown };
}

module.exports = { collect, known };

if (require.main === module) {
  (async () => {
    const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
    const strict = process.argv.includes('--strict');
    const urls = collect();
    console.log(`адресов в базе: ${urls.length}`);
    let dead = 0, unknown = 0;
    for (const [name, fn] of [['portal', checkPortal], ['registry', checkRegistry], ['other', checkOther]]) {
      if (only && only !== name) continue;
      const r = await fn(urls); dead += r.dead; unknown += r.unknown;
    }
    console.log(`итог: мёртвых и неверных ${dead}, неизвестных ${unknown}`);
    process.exit(dead || (strict && unknown) ? 1 : 0);
  })().catch((e) => { console.error('ОШИБКА', e.message); process.exit(2); });
}
