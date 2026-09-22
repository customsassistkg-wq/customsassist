// Метрики процесса для дашборда администраторов (dash.customsassist.trade, routes/dash.js).
//
// Всё живёт в памяти одного процесса и обнуляется при перезапуске — как и счётчики
// /api/engine. Здесь считаются только запросы и статусы ответов по маршрутам, задержка
// цикла событий и последние строки console.error/console.warn — те же, что уходят в
// journald. Содержимое запросов (коды, названия, тексты вопросов) не записывается:
// privacy.html обещает, что поисковые запросы не журналируются.
const { monitorEventLoopDelay } = require('node:perf_hooks');
const util = require('node:util');
const tls = require('node:tls');

const startedAt = Date.now();
const MINUTES = 60;          // окно поминутных корзин
const ERRORS_KEEP = 50;      // кольцо последних строк журнала
const ROUTES_MAX = 60;       // защита от разрастания карты по случайным путям

const routes = new Map();    // 'METHOD /api/x' → { count, ms, maxMs, s4, s5 }
const minutes = [];          // [{ t: минута (unix/60), n, e4, e5, ms }]
const errors = [];           // [{ t: ISO, level, msg }]
const status = { s2: 0, s3: 0, s4: 0, s5: 0, s401: 0, s403: 0, s429: 0 };
let total = 0;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Ключ считается в начале запроса по originalUrl: внутри смонтированного маршрутизатора
// Express урезает req.url до «/login», и к событию finish он таким и остаётся.
function routeKey(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (!path.startsWith('/api/')) return 'static';
  // /api/admin/users/<uuid>/role → /api/admin/users/:id/role; остальное как есть, но коротко.
  const p = path.replace(UUID_RE, ':id').replace(/\/+$/, '').slice(0, 60);
  return req.method + ' ' + (p || '/');
}

function bucket(now) {
  const t = Math.floor(now / 60000);
  const last = minutes[minutes.length - 1];
  if (last && last.t === t) return last;
  const b = { t, n: 0, e4: 0, e5: 0, ms: 0 };
  minutes.push(b);
  if (minutes.length > MINUTES) minutes.splice(0, minutes.length - MINUTES);
  return b;
}

function record(key, res, ms) {
  const now = Date.now();
  const st = res.statusCode;
  total++;
  if (st >= 500) status.s5++; else if (st >= 400) status.s4++; else if (st >= 300) status.s3++; else status.s2++;
  if (st === 401) status.s401++; else if (st === 403) status.s403++; else if (st === 429) status.s429++;
  const b = bucket(now);
  b.n++; b.ms += ms;
  if (st >= 500) b.e5++; else if (st >= 400) b.e4++;
  let r = routes.get(key);
  if (!r) {
    if (routes.size >= ROUTES_MAX) return;
    r = { count: 0, ms: 0, maxMs: 0, s4: 0, s5: 0 };
    routes.set(key, r);
  }
  r.count++; r.ms += ms; if (ms > r.maxMs) r.maxMs = ms;
  if (st >= 500) r.s5++; else if (st >= 400) r.s4++;
}

// Express-middleware: время до события finish ответа.
function middleware(req, res, next) {
  const t0 = process.hrtime.bigint();
  const key = routeKey(req);
  res.on('finish', () => {
    try { record(key, res, Number(process.hrtime.bigint() - t0) / 1e6); } catch (e) { /* метрики не роняют запрос */ }
  });
  next();
}

function fmtArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'string') return a;
  try { return util.inspect(a, { depth: 2, breakLength: Infinity }); } catch (e) { return String(a); }
}
function pushLog(level, args) {
  errors.push({ t: new Date().toISOString(), level, msg: args.map(fmtArg).join(' ').replace(/\s+/g, ' ').slice(0, 400) });
  if (errors.length > ERRORS_KEEP) errors.splice(0, errors.length - ERRORS_KEEP);
}

let hooked = false;
function hookConsole() {
  if (hooked) return;
  hooked = true;
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try { pushLog(level, args); } catch (e) { /* никогда не мешать самому журналу */ }
      orig(...args);
    };
  }
}

// Задержка цикла событий: гистограмма с момента последнего снимка (дашборд обновляется раз в минуту).
let loop = null;
function startLoop() {
  if (loop) return;
  try {
    loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
  } catch (e) { loop = null; }
}
function loopSnapshot() {
  if (!loop) return null;
  const ns = (v) => (Number.isFinite(v) ? Math.round(v / 1e4) / 100 : null); // нс → мс, два знака
  const out = { meanMs: ns(loop.mean), p99Ms: ns(loop.percentile(99)), maxMs: ns(loop.max) };
  loop.reset();
  return out;
}

// Срок TLS-сертификата сайта: сервер сам открывает TLS-соединение к своему имени и читает
// дату из сертификата — файлы Let's Encrypt процессу tnved недоступны. Ответ помнится час.
const certCache = new Map(); // host → { at, validTo, daysLeft, error }
function certInfo(host) {
  const c = certCache.get(host);
  if (c && Date.now() - c.at < 3600e3) return Promise.resolve(c);
  return new Promise((resolve) => {
    const done = (v) => { const rec = { at: Date.now(), host, ...v }; certCache.set(host, rec); resolve(rec); };
    let sock;
    try {
      sock = tls.connect({ host, port: 443, servername: host, timeout: 5000, rejectUnauthorized: false }, () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        if (!cert || !cert.valid_to) return done({ error: 'no certificate' });
        const validTo = new Date(cert.valid_to);
        const names = String(cert.subjectaltname || '').replace(/DNS:/g, '');
        done({ validTo: validTo.toISOString(), daysLeft: Math.floor((validTo - Date.now()) / 86400e3),
          covers: names.split(', ').includes(host), issuer: cert.issuer && cert.issuer.O || null });
      });
      sock.on('timeout', () => { sock.destroy(); done({ error: 'timeout' }); });
      sock.on('error', (err) => done({ error: err.code || err.message }));
    } catch (err) { done({ error: err.message }); }
  });
}

function snapshot() {
  const now = Date.now();
  const cur = Math.floor(now / 60000);
  // Ровно 60 минут, включая пустые: график читается по времени, а не по числу корзин.
  const byMinute = new Map(minutes.map((b) => [b.t, b]));
  const series = [];
  for (let t = cur - MINUTES + 1; t <= cur; t++) {
    const b = byMinute.get(t);
    series.push({ t: t * 60000, n: b ? b.n : 0, e4: b ? b.e4 : 0, e5: b ? b.e5 : 0, avgMs: b && b.n ? Math.round(b.ms / b.n) : 0 });
  }
  const routeRows = [...routes].map(([key, r]) => ({ key, count: r.count, avgMs: Math.round(r.ms / r.count), maxMs: Math.round(r.maxMs), s4: r.s4, s5: r.s5 }))
    .sort((a, b) => b.count - a.count).slice(0, 25);
  return { startedAt: new Date(startedAt).toISOString(), total, status: { ...status }, minutes: series, routes: routeRows,
    errors: errors.slice().reverse(), loop: loopSnapshot() };
}

function install(app) {
  hookConsole();
  startLoop();
  app.use(middleware);
}

module.exports = { install, middleware, snapshot, certInfo, hookConsole, pushLog };
