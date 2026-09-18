require('dotenv').config();
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

// Помощник принимает страницы документов в base64 (/read — по одной; вопрос — со старых вкладок) — остальному API
// хватает стандартных 100 КБ, и поднимать лимит для всех незачем. Большое тело
// разбирается только после проверки сессии (ниже, после authMiddleware): до
// 17.09.2026 его разбирал любой запрос без входа, и 15-мегабайтные JSON грузили
// процесс раньше, чем маршрут отвечал 401.
const ASSISTANT_PATH = /^\/api\/assistant(?:\/read)?\/?$/;
const jsonDefault = express.json();
const jsonAssistant = express.json({ limit: '15mb' });
app.use((req, res, next) => (ASSISTANT_PATH.test(req.path) ? next() : jsonDefault(req, res, next)));

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
const ALLOWED_ORIGINS = (process.env.APP_ORIGIN || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

let warnedMissingOrigin = false;
app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();

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


// Convenience for local dev (`npm run dev`) without Nginx in front - in
// production Nginx serves the static file directly per CLAUDE.md, and this
// must not also serve the whole repo root (source, migrations, session.md)
// if the Node process is ever reached directly.
if (process.env.NODE_ENV !== 'production') {
  const root = path.join(__dirname, '..', '..');
  app.get(['/', '/tnved_checker.html', '/privacy.html', '/terms.html', '/manifest.webmanifest', '/email-logo.jpg', '/app-bg-dark.webp', '/app-bg-light.webp', '/app-logo-dark.webp', '/app-logo-light.webp', '/login-bg-dark.webp', '/login-bg-light.webp', '/login-logo-dark.webp', '/login-logo-light.webp'], (req, res) => {
    res.sendFile(path.join(root, req.path === '/' ? 'tnved_checker.html' : req.path.slice(1)));
  });
  app.use('/icons', express.static(path.join(root, 'icons')));
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
  // База грузится до открытия порта: первый поиск пользователя не ждёт разбора 12 МБ.
  require('./services/base').load();
  const port = process.env.PORT || 3000;
  // Только loopback: снаружи API доступен через Nginx. На всех интерфейсах порт
  // закрывал лишь UFW, а при trust proxy прямой запрос подделал бы X-Forwarded-For
  // и обошёл лимиты по IP.
  app.listen(port, '127.0.0.1', () => console.log(`tnved-api listening on 127.0.0.1:${port}`));
}

module.exports = app;
