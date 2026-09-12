const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../db');
const { sendEmail, renderEmail } = require('../services/email');
const { verifyTurnstile, isEnabled: turnstileEnabled, siteKey: turnstileSiteKey } = require('../services/turnstile');
const { endUserSessions } = require('../services/sessions');

const router = express.Router();

// Канонический адрес для ссылок в письмах. APP_ORIGIN с 11.09.2026 — это
// СПИСОК разрешённых origin (домен плюс старый адрес, на который указывает
// мобильное приложение), и подставлять его в ссылку целиком нельзя: получится
// "https://a,https://b/?reset=...". Берём явный PUBLIC_ORIGIN, а если его нет —
// первый origin списка. Вычисляется на каждый вызов, чтобы тесты и локальная
// разработка могли менять переменные окружения после загрузки модуля.
function publicOrigin() {
  const explicit = process.env.PUBLIC_ORIGIN;
  const first = (process.env.APP_ORIGIN || '').split(',')[0];
  return (explicit || first || '').trim().replace(/\/+$/, '');
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
// Подтверждение адреса живёт сутки, а не час: ссылку сброса человек ждёт
// прямо сейчас, а письмо о регистрации вполне может быть открыто вечером.
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFY_RESEND_COOLDOWN_MS = 2 * 60 * 1000;
const RESET_RESEND_COOLDOWN_MS = 2 * 60 * 1000; // don't mint a 2nd token within 2 min of a still-valid one
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRIAL_DAYS = 3;
const REGISTER_RATE_LIMIT = 5; // attempts
const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000; // per IP, per hour
const LOGIN_RATE_LIMIT = 10; // attempts
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000; // per IP, per 15 min
const FORGOT_RATE_LIMIT = 5; // attempts
const FORGOT_RATE_WINDOW_MS = 60 * 60 * 1000; // per IP, per hour

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Crude in-process anti-abuse, and the first line of defence rather than the
// only one: Cloudflare Turnstile sits in front of registration and password
// reset (see services/turnstile.js), while this cap still applies to every
// attempt including the ones that never reach the captcha. A Map is fine at
// this app's single-instance, low-traffic scale. Every endpoint that needs a
// per-IP cap builds one of these rather than copy-pasting the same six lines:
// registration, login (so a known account's password can't be brute-forced),
// and password reset (so the Resend quota can't be burned through).
//
// Entries are swept once per window on use, so an IP that stops calling stops
// costing memory — the earlier hand-rolled copies never removed anything, which
// left one array per IP that had ever touched the endpoint alive until restart.
function makeRateLimiter(limit, windowMs) {
  const hits = new Map();
  let lastSweep = Date.now();
  return function check(ip) {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [key, times] of hits) {
        if (!times.some((t) => now - t < windowMs)) hits.delete(key);
      }
      lastSweep = now;
    }
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length <= limit;
  };
}

const checkRegisterRateLimit = makeRateLimiter(REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS);
const checkLoginRateLimit = makeRateLimiter(LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS);
const checkForgotRateLimit = makeRateLimiter(FORGOT_RATE_LIMIT, FORGOT_RATE_WINDOW_MS);

// Публичные настройки для страницы. Публичный ключ Turnstile не секрет —
// он и так виден в разметке виджета. Отдаём его отдельным запросом, а не
// зашиваем в HTML, чтобы включение капчи было правкой .env и перезапуском
// службы, а не пересборкой и выкатом восьмимегабайтного файла.
router.get('/config', (req, res) => {
  res.json({ turnstileSiteKey: turnstileEnabled() ? (turnstileSiteKey() || null) : null });
});

router.post('/login', async (req, res, next) => {
  try {
    if (!checkLoginRateLimit(req.ip)) {
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }

    const { rows } = await pool.query(
      'select id, email, password_hash, role, active, subscription_expires_at from users where email = $1',
      [String(email).toLowerCase()]
    );
    const user = rows[0];
    // Same generic error whether the email doesn't exist or the password is
    // wrong, so a caller can't use this endpoint to enumerate accounts.
    if (!user || !user.active) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    // Checked only after the password is verified, so a failed-login probe
    // can't be used to tell an expired account apart from a wrong password.
    if (user.role !== 'admin' && user.subscription_expires_at && new Date(user.subscription_expires_at) < new Date()) {
      return res.status(403).json({ error: 'subscription_expired' });
    }

    // Enforce a single active session per account: a fresh login kicks out
    // any session already logged in as this user, so sharing one account's
    // credentials can't put two people in at the same time — the second
    // login always wins and the first is logged out on its next request
    // (told why via req.authReason — see middleware/auth.js).
    await endUserSessions(user.id, 'replaced');
    await pool.query('update users set last_login_at=now(), last_seen_at=now() where id=$1', [user.id]);

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      res.json({
        email: user.email,
        role: user.role,
        subscriptionExpiresAt: user.subscription_expires_at,
      });
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('tnved.sid');
    res.json({ ok: true });
  });
});


// Выпускает токен подтверждения и шлёт письмо. Вызывается и при регистрации,
// и по кнопке «отправить ещё раз». Ошибка отправки намеренно не роняет
// вызывающий запрос: аккаунт уже создан, и человек не должен видеть 500
// из-за того, что почтовый сервис моргнул — он повторит отправку кнопкой.
async function issueVerification(user) {
  const { rows: recent } = await pool.query(
    `select 1 from email_verification_tokens
      where user_id=$1 and used_at is null and expires_at>now()
        and created_at>now()-make_interval(secs=>$2::double precision)
      limit 1`,
    [user.id, VERIFY_RESEND_COOLDOWN_MS / 1000]
  );
  if (recent[0]) return { skipped: 'cooldown' };

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'insert into email_verification_tokens (user_id, token_hash, expires_at) values ($1,$2,$3)',
    [user.id, hashToken(token), new Date(Date.now() + VERIFY_TOKEN_TTL_MS)]
  );
  const url = `${publicOrigin()}/?verify=${token}`;
  await sendEmail({
    to: user.email,
    subject: 'Подтвердите адрес почты — Customs Assist KG',
    html: renderEmail({
      title: 'Подтвердите адрес почты',
      intro: 'Вы зарегистрировались в Customs Assist KG — сервисе проверки кодов ТН ВЭД Кыргызской Республики и ЕАЭС. Остался один шаг: подтвердите, что этот адрес ваш.',
      actionUrl: url,
      actionText: 'Подтвердить адрес',
      outro: 'Ссылка действительна 24 часа. Пользоваться сервисом можно и до подтверждения, но без него мы не сможем восстановить вам пароль.',
      footNote: 'Если вы не регистрировались в Customs Assist KG, просто не открывайте ссылку — учётная запись останется неподтверждённой.',
    }),
  });
  return { sent: true };
}

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, website } = req.body || {};
    // Honeypot: a hidden field real browsers never fill in — a bot that
    // blindly fills every field it finds does. Reject quietly, with the
    // same generic error a validation failure would give, so a bot can't
    // tell it was specifically caught by this rather than just malformed.
    if (website) {
      return res.status(400).json({ error: 'invalid request' });
    }
    if (!checkRegisterRateLimit(req.ip)) {
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }
    if (!EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: 'invalid email' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    // Капча проверяется последней из проверок и до первой дорогой операции.
    // Порядок не случаен: токен Turnstile одноразовый, поэтому сжигать его
    // на форме, которая всё равно не пройдёт проверку длины пароля, нельзя —
    // человеку пришлось бы решать капчу заново из-за собственной опечатки.
    const captcha = await verifyTurnstile(req.body && req.body.turnstileToken, req.ip, 'register');
    if (!captcha.ok) {
      return res.status(400).json({ error: 'captcha failed' });
    }

    const hash = await bcrypt.hash(password, 12);
    let rows;
    try {
      ({ rows } = await pool.query(
        `insert into users (email, password_hash, role, subscription_expires_at, last_login_at, last_seen_at)
         values ($1,$2,'user', now() + make_interval(days=>$3), now(), now())
         returning id, email, role, active, subscription_expires_at`,
        [String(email).toLowerCase(), hash, TRIAL_DAYS]
      ));
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'email already exists' });
      throw e;
    }
    const user = rows[0];

    // Self-registration has no admin actor — logged with the new user as
    // their own actor, same admin_audit_log table the admin panel uses.
    await pool.query(
      'insert into admin_audit_log (actor_id, action, target_user_id, detail) values ($1,$2,$3,$4)',
      [user.id, 'self_register', user.id, JSON.stringify({ email: user.email, trial_days: TRIAL_DAYS })]
    );

    // Письмо уходит в фоне и его результат не влияет на ответ: регистрация
    // уже состоялась, а ждать почтовый сервис значит держать человека перед
    // крутящейся кнопкой. Неудача попадёт в журнал, и есть кнопка повтора.
    issueVerification(user).catch((e) =>
      console.error('verification email failed:', e.message));

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      res.status(201).json({
        email: user.email,
        role: user.role,
        subscriptionExpiresAt: user.subscription_expires_at,
        emailVerified: false,
      });
    });
  } catch (err) {
    next(err);
  }
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};

  // The generic body alone was not enough to stop account enumeration: the
  // old code awaited the outbound Resend call before answering a registered
  // address but returned immediately for an unknown one, so response *timing*
  // still separated the two. Answer first, unconditionally and identically,
  // then do the real work detached from the response.
  res.json({ ok: true });

  // Checked after the reply on purpose — a 429 here would itself be a signal,
  // and there is nothing useful to tell the caller anyway.
  if (!checkForgotRateLimit(req.ip)) return;
  if (!email) return;

  // Капча здесь тоже после ответа, и по той же причине: сказать «капча не
  // пройдена» значит ответить по-разному на разные запросы, а весь смысл
  // этого обработчика в том, что ответ всегда одинаковый. Непройденная
  // проверка просто не приводит к письму.
  const captcha = await verifyTurnstile(req.body && req.body.turnstileToken, req.ip, 'forgot-password');
  if (!captcha.ok) return;

  try {
    const { rows } = await pool.query(
      'select id, email, active from users where email = $1',
      [String(email).toLowerCase()]
    );
    const user = rows[0];
    if (!user || !user.active) return;

    // Anti-spam: skip minting (and emailing) a new token if a still-valid,
    // unused one was already issued in the last couple of minutes — so
    // repeatedly mashing "send" doesn't burn through the Resend daily quota
    // or flood the recipient's inbox.
    const { rows: recent } = await pool.query(
      `select 1 from password_reset_tokens
       where user_id=$1 and used_at is null and expires_at>now()
         and created_at>now()-make_interval(secs=>$2::double precision)
       limit 1`,
      [user.id, RESET_RESEND_COOLDOWN_MS / 1000]
    );
    if (recent[0]) return;

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1,$2,$3)',
      [user.id, hashToken(token), new Date(Date.now() + RESET_TOKEN_TTL_MS)]
    );

    const resetUrl = `${publicOrigin()}/?reset=${token}`;
    await sendEmail({
      to: user.email,
      subject: 'Восстановление пароля — Customs Assist KG',
      html: renderEmail({
        title: 'Восстановление пароля',
        intro: 'Вы запросили смену пароля в Customs Assist KG. Нажмите кнопку ниже и придумайте новый.',
        actionUrl: resetUrl,
        actionText: 'Установить новый пароль',
        outro: 'Ссылка действительна 1 час и сработает один раз.',
        footNote: 'Если вы не запрашивали восстановление, просто проигнорируйте это письмо — пароль останется прежним.',
      }),
    });
  } catch (err) {
    // Nothing here can reach the caller any more — the response was already
    // sent — so every failure (a send rejected by Resend's sandbox before a
    // domain is verified, a DB error) is logged for server-side diagnosis and
    // deliberately goes no further. Not passed to next(): Express would try to
    // write a 500 onto an already-finished response.
    console.error('forgot-password failed:', err.message);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: 'token and password required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const { rows } = await pool.query(
      `select prt.id as token_id, u.id as user_id, u.active
       from password_reset_tokens prt
       join users u on u.id = prt.user_id
       where prt.token_hash=$1 and prt.used_at is null and prt.expires_at>now()`,
      [hashToken(token)]
    );
    const row = rows[0];
    if (!row || !row.active) {
      return res.status(400).json({ error: 'invalid or expired token' });
    }

    const hash = await bcrypt.hash(password, 12);
    await pool.query('update users set password_hash=$1 where id=$2', [hash, row.user_id]);
    // Burn every outstanding token for this user, not only the one just
    // spent: any other live reset link was minted by someone who could read
    // the old mailbox, and the password has now changed out from under it.
    await pool.query(
      'update password_reset_tokens set used_at=now() where user_id=$1 and used_at is null',
      [row.user_id]
    );
    // A changed password invalidates any session logged in under the old
    // one, same as disabling an account does elsewhere in this file.
    await endUserSessions(row.user_id, 'password_reset');

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});


// Подтверждение адреса по ссылке из письма. Токен разовый: помечаем
// использованным и ставим отметку у пользователя.
router.post('/verify-email', async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    const { rows } = await pool.query(
      `select evt.id as token_id, u.id as user_id, u.email, u.email_verified_at
         from email_verification_tokens evt join users u on u.id = evt.user_id
        where evt.token_hash=$1 and evt.used_at is null and evt.expires_at>now()`,
      [hashToken(token)]
    );
    const row = rows[0];
    if (!row) return res.status(400).json({ error: 'invalid or expired token' });

    await pool.query('update email_verification_tokens set used_at=now() where id=$1', [row.token_id]);
    if (!row.email_verified_at) {
      await pool.query('update users set email_verified_at=now() where id=$1', [row.user_id]);
    }
    res.json({ ok: true, email: row.email });
  } catch (err) {
    next(err);
  }
});

// Повторная отправка — только себе и только войдя: иначе маршрут стал бы
// способом слать письма на чужой адрес чужими руками.
router.post('/resend-verification', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    if (req.user.email_verified_at) return res.json({ ok: true, alreadyVerified: true });
    const r = await issueVerification(req.user);
    res.json({ ok: true, cooldown: r.skipped === 'cooldown' });
  } catch (err) {
    console.error('resend verification failed:', err.message);
    res.status(502).json({ error: 'mail service unavailable' });
  }
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated', reason: req.authReason || null });
  res.json({
    email: req.user.email,
    role: req.user.role,
    subscriptionExpiresAt: req.user.subscription_expires_at,
    emailVerified: !!req.user.email_verified_at,
  });
});

module.exports = router;
