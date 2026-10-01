require('dotenv').config();
// На этой машине маршрут IPv6 прописан, но связи по нему нет: curl -6 не проходит, а ip -6 route
// показывает default via fe80::1. Node с версии 18 ходит по порядку, в котором отвечает DNS, и для
// адресов за Cloudflare первым получает AAAA — соединение висит до таймаута и падает с
// UND_ERR_CONNECT_TIMEOUT. Из-за этого через раз не уходили письма Resend (подтверждение адреса,
// сброс пароля, ответы на обращения) и срывались вызовы модели, Vision и курсов НБКР: curl в тех же
// условиях работал и маскировал причину, потому что сам откатывается на IPv4 (найдено 23.09.2026).
// Спрашиваем IPv4 первым; когда IPv6 на сервере починят, строка останется безвредной.
require('node:dns').setDefaultResultOrder('ipv4first');
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');

const { pool } = require('./db');
const authMiddleware = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const classDecisionsRoutes = require('./routes/classDecisions');
const classDecisionsService = require('./services/classDecisions');
const nbkrRatesRoutes = require('./routes/nbkrRates');
const nbkrRatesService = require('./services/nbkrRates');

const PgSession = pgSessionFactory(session);
const app = express();

// Nothing good comes of advertising the framework version.
app.disable('x-powered-by');

// Needed so `secure` cookies and req.ip work correctly behind the Nginx
// reverse proxy described in CLAUDE.md's deploy notes.
app.set('trust proxy', 1);

// Счётчики запросов по маршрутам, задержка цикла событий и последние строки журнала —
// для дашборда администраторов (routes/dash.js). Первым в цепочке, чтобы считать и отказы.
require('./services/metrics').install(app);

// Помощник принимает страницы документов в base64 (/read — по одной; вопрос — со старых вкладок) — остальному API
// хватает стандартных 100 КБ, и поднимать лимит для всех незачем. Большое тело
// разбирается только после проверки сессии (ниже, после authMiddleware): до
// 17.09.2026 его разбирал любой запрос без входа, и 15-мегабайтные JSON грузили
// процесс раньше, чем маршрут отвечал 401.
const ASSISTANT_PATH = /^\/api\/assistant(?:\/read)?\/?$/;
// Входящее письмо приходит целиком как message/rfc822: разбирает его сам маршрут
// (routes/mail.js), поэтому разбор JSON на этом пути не нужен и только мешал бы.
const MAIL_INBOUND_PATH = /^\/api\/mail\/inbound\/?$/;
const PAY_CALLBACK_PATH = /^\/api\/pay\/(callback|check)\/?$/;
// Команды боту от Telegram и отчёт рутины Claude Code (routes/ops.js): без браузера и cookie.
// Чтение официальных сайтов для рутины (/api/ops/fetch) — GET, проверка Origin его не касается.
const OPS_PATH = /^\/api\/ops\/(telegram|report)\/?$/;
const jsonDefault = express.json();
const jsonAssistant = express.json({ limit: '15mb' });
app.use((req, res, next) => (ASSISTANT_PATH.test(req.path) || MAIL_INBOUND_PATH.test(req.path) ? next() : jsonDefault(req, res, next)));

// Для внешнего монитора доступности (docs/backend-ops.md, «Монитор доступности»): API отвечает, база
// ТН ВЭД разобрана, PostgreSQL отвечает. Наружу — только да/нет, без версий, чисел и причин. До сессии:
// проверка не создаёт и не читает сессий.
app.get('/api/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const baseOk = !!require('./services/base').info.loadedAt;
  let dbOk = false, timer;
  try {
    await Promise.race([pool.query('select 1'), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 3000); })]);
    dbOk = true;
  } catch {
    // PostgreSQL недоступна или не ответила за 3 с
  } finally {
    clearTimeout(timer);
  }
  res.status(baseOk && dbOk ? 200 : 503).json({ ok: baseOk && dbOk });
});

app.use(
  session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    name: 'tnved.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// Minimal CSRF mitigation: reject cross-origin mutating requests. Cheap but
// sufficient for an internal tool - see CLAUDE.md/plan notes before adding a
// full CSRF-token library.
//
// This deliberately fails *closed*. The previous version skipped the check
// whenever the Origin header was absent or APP_ORIGIN was unset, which meant a
// misconfigured deploy silently ran with no CSRF protection at all. Per the
// Fetch standard a browser sends Origin on every request except a same-origin
// GET/HEAD, so requiring it on mutating requests costs real clients nothing -
// including the Capacitor wrapper in mobile/, which loads the site over its
// real https origin (capacitor.config.json) and so sends exactly that value.
//
// APP_ORIGIN accepts a comma-separated list, because a domain move needs two
// origins alive at once: the browser starts using the new domain immediately,
// while every already-installed copy of the Capacitor app in mobile/ keeps
// loading the origin pinned in its capacitor.config.json until the store
// release reaches the user's phone. A single value stays valid and behaves
// exactly as before.
// DASH_ORIGIN — дашборд администраторов на своём имени (routes/dash.js): тот же API,
// поэтому его origin тоже разрешён. Пустая переменная — дашборд не опубликован.
const ALLOWED_ORIGINS = ((process.env.APP_ORIGIN || '') + ',' + (process.env.DASH_ORIGIN || ''))
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

let warnedMissingOrigin = false;
app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  // Единственное исключение: письмо от Cloudflare Email Worker. Браузера в этой цепочке нет,
  // Origin не шлётся и cookie не участвует, поэтому подделывать межсайтовым запросом нечего;
  // маршрут проверяет общий секрет и сессию не трогает (routes/mail.js).
  if (MAIL_INBOUND_PATH.test(req.path)) return next();
  // Webhook и check_url xPay: тоже без браузера и cookie; тело не читается, номер заказа — только
  // повод спросить xPay о статусе самим или ответить «можно платить / нельзя» (routes/pay.js),
  // так что межсайтовый запрос ничего не даёт.
  if (PAY_CALLBACK_PATH.test(req.path)) return next();
  // Webhook бота и отчёт рутины: у каждого свой секрет в заголовке, сессия не участвует (routes/ops.js).
  if (OPS_PATH.test(req.path)) return next();

  const allowed = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : null;
  if (!allowed) {
    // Local dev without APP_ORIGIN stays usable; a production process without
    // it is a misconfiguration worth refusing rather than quietly downgrading.
    if (process.env.NODE_ENV === 'production') {
      console.error('APP_ORIGIN is not set - refusing mutating request');
      return res.status(500).json({ error: 'server misconfigured' });
    }
    if (!warnedMissingOrigin) {
      warnedMissingOrigin = true;
      console.warn('APP_ORIGIN is not set - CSRF origin check disabled (dev only)');
    }
    return next();
  }

  if (!allowed.includes(req.get('origin'))) {
    return res.status(403).json({ error: 'bad origin' });
  }
  next();
});

app.use(authMiddleware);
app.use((req, res, next) => (ASSISTANT_PATH.test(req.path) && req.user ? jsonAssistant(req, res, next) : next()));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/class-decisions', classDecisionsRoutes);
app.use('/api/nbkr-rates', nbkrRatesRoutes);
app.use('/api/checker.js', require('./routes/checker'));
app.use('/api/engine', require('./routes/engine'));
app.use('/api/assistant', require('./routes/assistant'));
// Приём входящей почты от Cloudflare Email Worker: вход не нужен, проверяется общий секрет.
app.use('/api/mail', require('./routes/mail'));
// Оплата подписки по QR (xPay): вошедший пользователь или тот, у кого подписка истекла.
app.use('/api/pay', require('./routes/pay'));
// «Мои коды»: слежение за изменениями по кодам ТН ВЭД (services/watch.js).
app.use('/api/watch', require('./routes/watch'));
// Разбор находок дозора из Telegram: команды боту и отчёт рутины Claude Code, каждый по своему секрету.
app.use('/api/ops', require('./routes/ops'));
// Ошибки программы в браузере — в журнал и администраторам; вход не нужен (экран входа — тоже код).
app.use('/api/client-error', require('./routes/clientError'));
// Дашборд администраторов: код интерфейса и данные — только администратору (requireAdmin).
const dash = require('./routes/dash');
app.get('/api/dash.js', dash.script);
app.use('/api/dash', dash.router);


// Convenience for local dev (`npm run dev`) without Nginx in front - in
// production Nginx serves the static file directly per CLAUDE.md, and this
// must not also serve the whole repo root (source, migrations, session.md)
// if the Node process is ever reached directly.
if (process.env.NODE_ENV !== 'production') {
  const root = path.join(__dirname, '..', '..');
  app.get(['/', '/tnved_checker.html', '/privacy.html', '/terms.html', '/ai-risk.json', '/manifest.webmanifest'], (req, res) => {
    res.sendFile(path.join(root, req.path === '/' ? 'tnved_checker.html' : req.path.slice(1)));
  });
  // Дашборд администраторов: в продакшене это отдельный хост (dash.customsassist.trade,
  // блок в nginx.conf с root server/dash), локально — /dash на том же порту.
  app.get('/dash', (req, res) => res.sendFile(path.join(root, 'server', 'dash', 'index.html')));
  // Картинки сайта — одной папкой assets/. Исходники логотипа (assets/source/) —
  // вход генераторов в tools/: на сервер они не выкладываются, здесь закрыты явно.
  app.use('/assets/source', (req, res) => res.status(404).end());
  app.use('/assets', express.static(path.join(root, 'assets')));
  // Старые адреса остаются рабочими: /icons/* помнят установленные на телефон копии
  // и iOS, /email-logo.jpg — уже отправленные письма. Nginx делает то же (server/nginx.conf).
  app.get('/email-logo.jpg', (req, res) => res.sendFile(path.join(root, 'assets', 'email-logo.jpg')));
  app.use('/icons', express.static(path.join(root, 'assets', 'icons')));
  app.use('/vendor', express.static(path.join(root, 'vendor'), {
    setHeaders: (res, file) => { if (file.endsWith('.mjs')) res.type('application/javascript'); },
  }));
}

app.use((err, req, res, next) => {
  // Битый JSON и слишком большое тело — ошибка клиента: 400/413, без трассировки в журнале.
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(err.status).json({ error: err.type });
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

// require() из теста получает app без фоновых загрузок и без открытого порта.
if (require.main === module) {
  classDecisionsService.init();
  nbkrRatesService.init();
  require('./services/retention').init();
  require('./routes/pay').init();
  require('./services/reminders').init();
  require('./services/watch').init();
  require('./routes/ops').init();
  // Счётчики перебора базы за сутки — из файла: перезапуск (каждая выкладка) их не обнуляет.
  const saveEngineUsage = require('./routes/engine').init();
  // Остановка (systemctl restart при выкладке) — сначала сохранить счётчики, потом выйти. Вопросы помощнику
  // в работе обрываются, как и раньше: ожидание их ответа держало бы порт закрытым до минуты.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      saveEngineUsage();
      process.exit(0);
    });
  }
  // База грузится до открытия порта: первый поиск пользователя не ждёт разбора 12 МБ.
  require('./services/base').load();
  require('./services/base').warm();
  const port = process.env.PORT || 3000;
  // Только loopback: снаружи API доступен через Nginx. На всех интерфейсах порт
  // закрывал лишь UFW, а при trust proxy прямой запрос подделал бы X-Forwarded-For
  // и обошёл лимиты по IP.
  app.listen(port, '127.0.0.1', () => console.log(`tnved-api listening on 127.0.0.1:${port}`));
}

module.exports = app;
