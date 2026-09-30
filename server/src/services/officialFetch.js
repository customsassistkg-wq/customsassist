// Чтение официальных сайтов для рутины разбора находок (routes/ops.js, GET /api/ops/fetch).
//
// Зачем: из облака Claude Code сайты *.gov.kg не открываются — www.gov.kg, customs.gov.kg,
// sti.gov.kg и vet.gov.kg обрывают соединение на TLS, gov.kg отдаёт цепочку без промежуточного
// сертификата (проверено 29.09.2026 двумя пробными запусками рутины). С сервера они читаются —
// так же их каждый день читает дозор (scripts/watch-sources.js). Рутина просит страницу у
// сервера, сервер читает её сам и отдаёт как есть, потоком.
//
// Это не открытый прокси: только GET, только https на 443-й порт и только по списку официальных
// сайтов (HOSTS); переадресация — только внутри списка; размер и время ограничены. Вызывающий
// предъявляет секрет отчёта — это проверяет маршрут.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const zlib = require('node:zlib');

// Те же сайты, что разрешены рутине в её окружении на claude.ai (docs/ops-routine.md), кроме
// самого customsassist.trade. Новый сайт — сюда и в документ в одном коммите.
const HOSTS = new Set([
  'gov.kg', 'www.gov.kg', 'customs.gov.kg', 'www.customs.gov.kg', 'sti.gov.kg', 'vet.gov.kg',
  'cbd.minjust.gov.kg', 'kenesh.kg', 'www.kenesh.kg',
  'docs.eaeunion.org', 'eec.eaeunion.org', 'nsi.eaeunion.org', 'remedies.eaeunion.org',
]);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const MAX_BYTES = 30 * 1024 * 1024;
const IDLE_MS = 40000;
const MAX_REDIRECTS = 4;

// gov.kg отдаёт лист без промежуточного RapidSSL — тот же файл, что у дозора.
let caCache = null;
function caList() {
  if (caCache) return caCache;
  let extra = [];
  try {
    extra = [fs.readFileSync(path.join(__dirname, '..', '..', 'certs', 'RapidSSLTLSRSACAG1.crt.pem'), 'utf8')];
  } catch { /* без файла не откроется только gov.kg */ }
  caCache = tls.rootCertificates.concat(extra);
  return caCache;
}

const fail = (code, message) => Object.assign(new Error(message), { code });

// Адрес годится, если это https без логина и чужого порта, а хост — из списка. URL или null.
function allowed(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (!HOSTS.has(u.hostname.toLowerCase())) return null;
  // Сертификат сайта Кабмина выписан на www.gov.kg: по имени без www соединение не проходит проверку.
  if (u.hostname === 'gov.kg') u.hostname = 'www.gov.kg';
  return u;
}

// Одно соединение: отдаёт ответ сайта, как только пришли заголовки. Вынесено в impl, чтобы тест
// подменял сеть, а проверки адреса и переадресаций оставались настоящими.
const impl = {
  open(u, referer) {
    return new Promise((resolve, reject) => {
      const req = https.request(u, {
        method: 'GET', family: 4, timeout: IDLE_MS, ca: caList(),
        headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'ru,en;q=0.8', 'Accept-Encoding': 'gzip, deflate', Referer: referer || u.origin + '/' },
      }, resolve);
      req.on('timeout', () => req.destroy(fail('timeout', `сайт ${u.hostname} не ответил за ${IDLE_MS / 1000} секунд`)));
      req.on('error', (err) => reject(err.code === 'timeout' ? err : fail('network', `сайт ${u.hostname} недоступен: ${err.code || err.message}`)));
      req.end();
    });
  },
};

// Открывает адрес, проходя переадресации внутри списка. { res, url } — поток ответа со статусом 200.
async function open(rawUrl, { referer } = {}) {
  let u = allowed(rawUrl);
  if (!u) throw fail('not-allowed', 'адрес не из списка официальных сайтов (https, без порта): ' + String(rawUrl).slice(0, 200));
  const ref = referer ? allowed(referer) : null;
  if (referer && !ref) throw fail('not-allowed', 'referer не из списка официальных сайтов');
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await impl.open(u, ref && ref.href);
    } catch (err) {
      // customs.gov.kg время от времени сбрасывает TLS на первом соединении — одна повторная попытка.
      if (err.code !== 'network') throw err;
      await new Promise((r) => setTimeout(r, 1500));
      res = await impl.open(u, ref && ref.href);
    }
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const next = allowed(new URL(res.headers.location, u).href);
      if (!next) throw fail('redirect', `сайт ${u.hostname} переадресует за пределы списка официальных сайтов`);
      u = next;
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw Object.assign(fail('upstream', `сайт ${u.hostname} ответил ${res.statusCode}`), { status: res.statusCode });
    }
    return { res, url: u.href };
  }
  throw fail('redirect', 'слишком много переадресаций');
}

// Отдаёт страницу в ответ Express потоком: тело — как у сайта, уже распакованное; больше
// MAX_BYTES — обрыв. Ошибка до заголовков бросается (маршрут ответит JSON), после — рвёт соединение.
async function pipe(rawUrl, opts, out) {
  const { res, url } = await open(rawUrl, opts);
  // Вызывающий отключился, пока сайт отвечал, — не качать впустую.
  if (out.destroyed) { res.destroy(); return 0; }
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  const body = enc.includes('gzip') ? res.pipe(zlib.createGunzip()) : enc.includes('deflate') ? res.pipe(zlib.createInflate()) : res;
  out.status(200);
  out.set('content-type', res.headers['content-type'] || 'application/octet-stream');
  out.set('cache-control', 'no-store');
  out.set('x-source-url', url);
  if (res.headers['last-modified']) out.set('x-source-last-modified', String(res.headers['last-modified']));
  let size = 0;
  return new Promise((resolve) => {
    const stop = () => { res.destroy(); out.destroy(); resolve(size); };
    body.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) return stop();
      if (!out.write(chunk)) { body.pause(); out.once('drain', () => body.resume()); }
    });
    body.on('end', () => { out.end(); resolve(size); });
    body.on('error', stop);
    res.on('error', stop);
    out.on('close', () => { res.destroy(); resolve(size); });
  });
}

module.exports = { HOSTS, allowed, open, pipe, impl, MAX_BYTES };
