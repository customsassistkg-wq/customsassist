const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../db');
const { sendEmail, renderEmail } = require('../services/email');
const { verifyTurnstile, isEnabled: turnstileEnabled, siteKey: turnstileSiteKey } = require('../services/turnstile');
const { endUserSessions } = require('../services/sessions');
const { issueVerification } = require('../services/verification');
const xpay = require('../services/xpay');
const telegram = require('../services/telegram');
const { browserOf } = require('../services/userAgent');
const totp = require('../services/totp');
const termsNotice = require('../services/termsNotice');
const PAY_SESSION_MS = 3600e3;

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

// Дашборд администраторов — отдельное имя (DASH_ORIGIN, например
// https://dash.customsassist.trade), тот же API за тем же Nginx. Вход на нём открыт
// только администраторам: обычной учётной записи там нечего делать, и сессии у неё
// не появляется. Имя хоста берётся из заголовка Host, который ставит Nginx.
function isDashHost(req) {
  const raw = String(process.env.DASH_ORIGIN || '').trim();
  if (!raw) return false;
  try { return req.hostname === new URL(raw).hostname; } catch (e) { return false; }
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
// Подтверждение адреса живёт сутки, а не час: ссылку сброса человек ждёт
// прямо сейчас, а письмо о регистрации вполне может быть открыто вечером.
const RESET_RESEND_COOLDOWN_MS = 2 * 60 * 1000; // don't mint a 2nd token within 2 min of a still-valid one
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRIAL_DAYS = 3;
// Редакция правил использования (terms.html). Новая редакция — новая дата здесь:
// у всех, кто принимал прежнюю, страница снова покажет окно «Принимаю».
const TERMS_VERSION = '2026-09-18';
const REGISTER_RATE_LIMIT = 5; // attempts
const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000; // per IP, per hour
const LOGIN_RATE_LIMIT = 10; // attempts
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000; // per IP, per 15 min
// Неудачные входы на один адрес — с любых IP: лимит по IP не останавливает перебор
// пароля к одной учётной записи с сотни адресов. Считаются только неудачи, поэтому
// владелец после чужих попыток ждёт не дольше окна, а существование адреса по
// отказу не угадать — счётчик ведётся для любого введённого адреса.
const LOGIN_FAIL_LIMIT = 20;
const LOGIN_FAIL_WINDOW_MS = 60 * 60 * 1000;
// После LOGIN_FAIL_LIMIT вход на адрес не закрывается наглухо, а требует капчу: глухой отказ
// позволял любому, кто знает адрес, держать владельца (и администратора) снаружи двадцатью
// запросами в час. Перебор с капчей ограничен вторым, жёстким порогом; без настроенной
// капчи действует прежний отказ.
const LOGIN_FAIL_HARD_LIMIT = 100;
// RFC 5321: адрес длиннее 254 знаков не доставляется; длиннее — только мусор в таблице и в памяти счётчиков.
const EMAIL_MAX = 254;
const FORGOT_RATE_LIMIT = 5; // attempts
const FORGOT_RATE_WINDOW_MS = 60 * 60 * 1000; // per IP, per hour

// Same cost as real hashes (bcrypt.hash(password, 12) below), so the dummy
// comparison takes as long as a real one.
const DUMMY_HASH = bcrypt.hashSync('not-a-password', 12);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Один ящик — одна пробная учётная запись. «user+a@…», «user+b@…», а у Gmail ещё и
// «u.ser@…» приходят в тот же ящик и проходят подтверждение адреса, то есть давали
// сколько угодно пробных сроков, квот помощника и суточных лимитов /api/engine одному
// человеку. Сам адрес хранится как введён; сравнивается каноническая форма — без
// «+метки», у Gmail без точек. Только для саморегистрации: администратор заводит любой.
function canonicalEmail(email) {
  let [local, domain] = String(email).toLowerCase().split('@');
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}
// То же выражением SQL над users.email. ponytail: полный просмотр таблицы на каждую
// регистрацию (их не больше пяти в час с адреса); при тысячах записей — индекс по выражению.
const CANONICAL_EMAIL_SQL = `case when split_part(email,'@',2) in ('gmail.com','googlemail.com')
  then replace(split_part(split_part(email,'@',1),'+',1),'.','') || '@gmail.com'
  else split_part(split_part(email,'@',1),'+',1) || '@' || split_part(email,'@',2) end`;

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
  // record=false — только спросить, не исчерпан ли лимит (для счётчика неудач).
  return function check(ip, record = true) {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [key, times] of hits) {
        if (!times.some((t) => now - t < windowMs)) hits.delete(key);
      }
      lastSweep = now;
    }
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (!record) return recent.length < limit;
    recent.push(now);
    hits.set(ip, recent);
    return recent.length <= limit;
  };
}

const checkRegisterRateLimit = makeRateLimiter(REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS);
const checkLoginRateLimit = makeRateLimiter(LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS);
const loginFailures = makeRateLimiter(LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW_MS);
const loginFailuresHard = makeRateLimiter(LOGIN_FAIL_HARD_LIMIT, LOGIN_FAIL_WINDOW_MS);
const checkForgotRateLimit = makeRateLimiter(FORGOT_RATE_LIMIT, FORGOT_RATE_WINDOW_MS);
// Повторная отправка письма подтверждения теперь нужна и без сессии: войти
// до подтверждения нельзя, значит попросить письмо заново человек может
// только с экрана входа. Ограничение то же, что у восстановления пароля.
const checkResendRateLimit = makeRateLimiter(FORGOT_RATE_LIMIT, FORGOT_RATE_WINDOW_MS);

// Публичные настройки для страницы. Публичный ключ Turnstile не секрет —
// он и так виден в разметке виджета. Отдаём его отдельным запросом, а не
// зашиваем в HTML, чтобы включение капчи было правкой .env и перезапуском
// службы, а не правкой и выкатом страницы.
router.get('/config', (req, res) => {
  // termsNotice — уведомление об изменении правил, пока не наступил день вступления (services/termsNotice.js)
  // fromPrice — цена самого дешёвого платного тарифа для строки под кнопкой регистрации: единственный источник цен — PLANS
  // (routes/assistant.js, переопределяется AI_PLAN_LIMITS), а не копия в разметке страницы.
  const prices = Object.values(require('./assistant').PLANS).map((p) => Number(p.price)).filter((x) => x > 0);
  res.json({ turnstileSiteKey: turnstileEnabled() ? (turnstileSiteKey() || null) : null, termsNotice: termsNotice.current(), fromPrice: prices.length ? Math.min(...prices) : null });
});

router.post('/login', async (req, res, next) => {
  try {
    if (!checkLoginRateLimit(req.ip)) {
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > EMAIL_MAX) {
      return res.status(400).json({ error: 'email and password required' });
    }
    const key = email.toLowerCase();
    if (!loginFailures(key, false)) {
      if (!turnstileEnabled() || !loginFailuresHard(key, false)) {
        return res.status(429).json({ error: 'too many attempts, try again later' });
      }
      const captcha = await verifyTurnstile(req.body.turnstileToken, req.ip, 'login');
      if (!captcha.ok) return res.status(429).json({ error: 'captcha_required' });
    }

    const { rows } = await pool.query(
      'select id, email, password_hash, role, active, subscription_expires_at, email_verified_at, terms_version, totp_secret, totp_enabled_at, totp_last_step, totp_recovery from users where email = $1',
      [key]
    );
    const user = rows[0];
    // Same generic error whether the email doesn't exist or the password is
    // wrong, so a caller can't use this endpoint to enumerate accounts — and
    // the same time too: bcrypt runs against a dummy hash for an unknown or
    // disabled account, otherwise the instant 401 gives the answer away.
    // Registration still answers 409 for a taken address on purpose: that
    // path is behind Turnstile and a per-IP limit, and «уже зарегистрирован»
    // is worth more to a real user than hiding it (decided 17.09.2026).
    const ok = await bcrypt.compare(password, user && user.active ? user.password_hash : DUMMY_HASH);
    if (!user || !user.active || !ok) {
      loginFailures(key);
      loginFailuresHard(key);
      return res.status(401).json({ error: 'invalid credentials' });
    }

    // Подтверждение адреса — тоже после проверки пароля, по той же причине,
    // что и срок подписки ниже: иначе перебором логинов можно было бы узнать,
    // какие адреса зарегистрированы, но не подтверждены.
    if (!user.email_verified_at) {
      return res.status(403).json({ error: 'email_not_verified' });
    }

    // Checked only after the password is verified, so a failed-login probe
    // can't be used to tell an expired account apart from a wrong password.
    // Пароль верен, поэтому оставляем в новой сессии payUserId на час: с ним открыты только
    // маршруты оплаты (routes/pay.js), userId нет — остальной сайт видит гостя.
    if (user.role !== 'admin' && user.subscription_expires_at && new Date(user.subscription_expires_at) < new Date()) {
      if (!xpay.enabled()) return res.status(403).json({ error: 'subscription_expired' });
      return req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.payUserId = user.id;
        req.session.payUntil = Date.now() + PAY_SESSION_MS;
        res.status(403).json({ error: 'subscription_expired', canPay: true });
      });
    }

    // Дашборд администраторов: не администратору — отказ уже после проверки пароля
    // (существование адреса по отказу не узнать), сессия не создаётся.
    const dash = isDashHost(req);
    if (dash && user.role !== 'admin') {
      return res.status(403).json({ error: 'admin_only' });
    }

    // Второй фактор (01.10.2026): у кого он включён, тому кроме пароля нужен код из приложения или код восстановления.
    // «Нужен код» отвечается только после верного пароля; сессии до кода нет; неверный код — такая же неудачная
    // попытка, как неверный пароль (те же лимиты и капча), и ещё своя: подбор кода идёт уже с верным паролем,
    // поэтому 10 неверных кодов в час закрывают вход до конца окна (и с верным кодом), а администраторам приходит
    // сообщение — пароль знает кто-то ещё, если это были не они.
    let second = null;
    if (user.totp_enabled_at) {
      if (!totpFailures(user.id, false)) return res.status(429).json({ error: 'too many attempts, try again later' });
      second = await checkSecondFactor(user, req.body || {});
      if (second === 'required') return res.status(401).json({ error: 'totp_required' });
      if (second === 'invalid') {
        loginFailures(key);
        loginFailuresHard(key);
        totpFailures(user.id);
        if (totpAlerts(user.id)) {
          telegram.notify(`⚠️ <b>Верный пароль, неверный код второго фактора</b>\n${telegram.esc(user.email)} · IP ${telegram.esc(req.ip)} · `
            + `${telegram.esc(browserOf(req.get('user-agent')))}\nЕсли это были не вы — пароль знает кто-то ещё: смените его в меню аккаунта. `
            + 'После 10 неверных кодов за час вход закрыт до конца часа.');
        }
        return res.status(401).json({ error: 'totp_invalid' });
      }
    }

    // Enforce a single active session per account: a fresh login kicks out
    // any session already logged in as this user, so sharing one account's
    // credentials can't put two people in at the same time — the second
    // login always wins and the first is logged out on its next request
    // (told why via req.authReason — see middleware/auth.js). Сессии дашборда
    // и основного сайта — два разных круга: вход в один не трогает другой.
    await endUserSessions(user.id, 'replaced', undefined, { dash });
    await pool.query('update users set last_login_at=now(), last_seen_at=now() where id=$1', [user.id]);
    // Вход администратора — сообщение администраторам в Telegram (01.10.2026): вход по угаданному или утёкшему паролю
    // иначе никто бы не заметил. Вход пользователей не сообщается.
    if (user.role === 'admin') {
      telegram.notify(`🔐 <b>Вход администратора</b>\n${telegram.esc(user.email)} · ${dash ? 'дашборд' : 'сайт'} · IP ${telegram.esc(req.ip)} · `
        + `${telegram.esc(browserOf(req.get('user-agent')))}`
        + (second && second.kind === 'recovery' ? `\n<b>По коду восстановления</b> — осталось кодов: ${second.left}.` : second ? '\nС кодом второго фактора.' : '')
        + '\nЕсли это были не вы — смените пароль в меню аккаунта и проверьте журнал администрирования.');
    }

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      if (dash) req.session.dash = true;
      const notice = termsNotice.current();
      termsNotice.recordShown(pool, req.session, user, notice);
      res.json({
        email: user.email,
        role: user.role,
        subscriptionExpiresAt: user.subscription_expires_at,
        termsAccepted: user.terms_version === TERMS_VERSION,
        payEnabled: xpay.enabled(),
        dashUrl: dashUrlFor(user),
        totpEnabled: !!user.totp_enabled_at,
        termsNotice: notice,
      });
    });
  } catch (err) {
    next(err);
  }
});

// Ссылка на дашборд в меню аккаунта — только администратору и только если дашборд опубликован.
function dashUrlFor(user) {
  if (user.role !== 'admin') return null;
  const raw = String(process.env.DASH_ORIGIN || '').split(',')[0].trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(raw) ? raw : null;
}

// Смена пароля из меню аккаунта (24.09.2026): текущий пароль обязателен — открытая вкладка
// на чужом компьютере не должна позволять увести учётную запись. Остальные сессии этого
// пользователя (и дашборда) завершаются с причиной password_reset («Пароль был изменён —
// войдите заново»), текущая остаётся: её userId пишется в хранилище заново.
const checkChangePasswordLimit = makeRateLimiter(10, 60 * 60 * 1000);
const PASSWORD_MAX = 200;
router.post('/change-password', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    const { current, password } = req.body || {};
    if (typeof current !== 'string' || typeof password !== 'string' || !current || !password) {
      return res.status(400).json({ error: 'current and password required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    if (password.length > PASSWORD_MAX) return res.status(400).json({ error: 'password too long' });
    if (!checkChangePasswordLimit(req.user.id)) return res.status(429).json({ error: 'too many attempts, try again later' });
    const { rows: [u] } = await pool.query('select password_hash from users where id = $1', [req.user.id]);
    if (!u || !(await bcrypt.compare(current, u.password_hash))) return res.status(403).json({ error: 'wrong current password' });
    if (await bcrypt.compare(password, u.password_hash)) return res.status(400).json({ error: 'same password' });
    const hash = await bcrypt.hash(password, 12);
    await pool.query('update users set password_hash = $1 where id = $2', [hash, req.user.id]);
    await pool.query('update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null', [req.user.id]);
    await endUserSessions(req.user.id, 'password_reset');
    req.session.userId = req.user.id;
    req.session.passwordChangedAt = Date.now();
    req.session.save((err) => (err ? next(err) : res.json({ ok: true })));
  } catch (err) {
    next(err);
  }
});

// ── Второй фактор входа (01.10.2026) ──────────────────────────────────────────
// Включает сам администратор в меню аккаунта; другим учётным записям маршруты отказывают (403). Секрет до первого
// верного кода лежит в сессии зашифрованным, в базу (тоже зашифрованным, services/totp.js) — после него; коды
// восстановления показываются один раз. Выключить — пароль и код (или код восстановления): с чужой открытой вкладки
// второй фактор не снять. Без телефона и кодов — scripts/totp-off.js на сервере.
const checkTotpLimit = makeRateLimiter(10, 60 * 60 * 1000);
const totpFailures = makeRateLimiter(10, 60 * 60 * 1000); // неверные коды при входе — на учётную запись
const totpAlerts = makeRateLimiter(1, 60 * 60 * 1000); // «верный пароль, неверный код» — раз в час на учётную запись

// Код из тела запроса → { kind: 'code' } | { kind: 'recovery', left } | 'required' | 'invalid'. Шаг кода и код
// восстановления «сгорают» условным UPDATE: два входа с одним и тем же кодом не проходят оба.
async function checkSecondFactor(user, { totp: code, recovery } = {}) {
  if (typeof code === 'string' && code.trim()) {
    let secret;
    try { secret = totp.unseal(user.totp_secret); } catch { return 'invalid'; }
    const step = totp.verify(secret, code, { lastStep: user.totp_last_step == null ? null : Number(user.totp_last_step) });
    if (step == null) return 'invalid';
    const { rowCount } = await pool.query('update users set totp_last_step = $1 where id = $2 and (totp_last_step is null or totp_last_step < $1)', [step, user.id]);
    return rowCount ? { kind: 'code' } : 'invalid';
  }
  if (typeof recovery === 'string' && recovery.trim()) {
    const list = Array.isArray(user.totp_recovery) ? user.totp_recovery : [];
    const i = totp.matchRecovery(list, recovery);
    if (i < 0) return 'invalid';
    const rest = list.filter((_, j) => j !== i);
    const { rowCount } = await pool.query('update users set totp_recovery = $1 where id = $2 and totp_recovery @> $3',
      [JSON.stringify(rest), user.id, JSON.stringify([list[i]])]);
    if (!rowCount) return 'invalid';
    await audit(user, 'totp_recovery_used', { left: rest.length });
    return { kind: 'recovery', left: rest.length };
  }
  return 'required';
}

async function audit(user, action, detail = {}) {
  await pool.query('insert into admin_audit_log (actor_id, action, target_user_id, detail) values ($1,$2,$3,$4)',
    [user.id, action, user.id, JSON.stringify({ email: user.email, ...detail })]);
}

function adminOnly(req, res) {
  if (!req.user) { res.status(401).json({ error: 'not authenticated' }); return false; }
  if (req.user.role !== 'admin') { res.status(403).json({ error: 'admin_only' }); return false; }
  return true;
}

router.post('/totp/setup', (req, res, next) => {
  if (!adminOnly(req, res)) return;
  if (req.user.totp_enabled_at) return res.status(409).json({ error: 'totp_already_enabled' });
  const secret = totp.newSecret();
  const uri = totp.otpauthUri(secret, req.user.email);
  req.session.totpPending = totp.seal(secret);
  req.session.save((err) => (err ? next(err) : res.json({ secret: totp.base32Encode(secret), uri, qr: totp.qrDataUrl(uri) })));
});

router.post('/totp/enable', async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    if (req.user.totp_enabled_at) return res.status(409).json({ error: 'totp_already_enabled' });
    if (!req.session.totpPending) return res.status(400).json({ error: 'totp_setup_required' });
    if (!checkTotpLimit(req.user.id)) return res.status(429).json({ error: 'too many attempts, try again later' });
    const step = totp.verify(totp.unseal(req.session.totpPending), (req.body || {}).code);
    if (step == null) return res.status(400).json({ error: 'totp_invalid' });
    const codes = totp.newRecoveryCodes();
    await pool.query('update users set totp_secret = $1, totp_enabled_at = now(), totp_last_step = $2, totp_recovery = $3 where id = $4',
      [req.session.totpPending, step, JSON.stringify(codes.map(totp.hashRecovery)), req.user.id]);
    delete req.session.totpPending;
    await audit(req.user, 'totp_enabled');
    telegram.notify(`🔐 <b>Второй фактор включён</b>\n${telegram.esc(req.user.email)} — вход теперь требует код из приложения.`);
    req.session.save((err) => (err ? next(err) : res.json({ ok: true, recovery: codes })));
  } catch (err) {
    next(err);
  }
});

router.post('/totp/disable', async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    if (!req.user.totp_enabled_at) return res.status(409).json({ error: 'totp_not_enabled' });
    if (!checkTotpLimit(req.user.id)) return res.status(429).json({ error: 'too many attempts, try again later' });
    const { password } = req.body || {};
    const { rows: [u] } = await pool.query('select id, email, password_hash, totp_secret, totp_last_step, totp_recovery from users where id = $1', [req.user.id]);
    if (!u || typeof password !== 'string' || !(await bcrypt.compare(password, u.password_hash))) return res.status(403).json({ error: 'wrong current password' });
    const second = await checkSecondFactor(u, req.body || {});
    if (second === 'required' || second === 'invalid') return res.status(400).json({ error: second === 'required' ? 'totp_required' : 'totp_invalid' });
    await pool.query('update users set totp_secret = null, totp_enabled_at = null, totp_last_step = null, totp_recovery = null where id = $1', [u.id]);
    await audit(req.user, 'totp_disabled');
    telegram.notify(`🔓 <b>Второй фактор выключен</b>\n${telegram.esc(req.user.email)} — вход снова только по паролю.`);
    res.json({ ok: true });
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
    // Нестроковое значение (массив, объект) иначе доходило до bcrypt и давало 500.
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }
    if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
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

    // После капчи, как и 409 ниже: ответ «уже зарегистрирован» не раздаётся без неё.
    const { rows: twin } = await pool.query(
      `select 1 from users where ${CANONICAL_EMAIL_SQL} = $1 limit 1`, [canonicalEmail(email)]);
    if (twin[0]) return res.status(409).json({ error: 'email already exists' });

    const hash = await bcrypt.hash(password, 12);
    let rows;
    try {
      ({ rows } = await pool.query(
        `insert into users (email, password_hash, role, subscription_expires_at, last_login_at, last_seen_at, terms_version, terms_accepted_at)
         values ($1,$2,'user', now() + make_interval(days=>$3), now(), now(), $4, now())
         returning id, email, role, active, subscription_expires_at`,
        [String(email).toLowerCase(), hash, TRIAL_DAYS, TERMS_VERSION]
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
    telegram.notify(`👤 <b>Новая регистрация</b>\n${telegram.esc(user.email)} — пробный доступ на ${TRIAL_DAYS} дн.`);
    // Регистрация и есть заключение соглашения: кнопка «Создать аккаунт» стоит
    // под ссылками на правила. Запись в журнале переживёт удаление аккаунта.
    await logTermsAccepted(user);

    // Письмо уходит в фоне и его результат не влияет на ответ: учётная запись
    // уже создана, а ждать почтовый сервис значит держать человека перед
    // крутящейся кнопкой. Неудача попадёт в журнал, и есть кнопка повтора.
    issueVerification(user).catch((e) =>
      console.error('verification email failed:', e.message));

    // Сессия НЕ создаётся: с 12.09.2026 пользоваться сервисом без
    // подтверждённого адреса нельзя. Раньше здесь шёл regenerate и человек
    // сразу попадал внутрь — это и позволяло зарегистрироваться на выдуманный
    // адрес и работать. Пробный срок по-прежнему отсчитывается от регистрации.
    res.status(201).json({
      email: user.email,
      needsVerification: true,
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
  if (typeof email !== 'string' || !email || email.length > EMAIL_MAX) return;

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
    if (typeof token !== 'string' || typeof password !== 'string' || !token || !password) {
      return res.status(400).json({ error: 'token and password required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize resets for the same account, including different live tokens.
      const { rows: users } = await client.query(
        `select u.id from users u join password_reset_tokens t on t.user_id=u.id
         where t.token_hash=$1 and u.active=true for update of u`, [hashToken(token)]);
      const user = users[0];
      const { rows: consumed } = user ? await client.query(
        `update password_reset_tokens set used_at=now()
         where token_hash=$1 and used_at is null and expires_at>now() returning id`,
        [hashToken(token)]) : { rows: [] };
      if (!consumed.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid or expired token' });
      }
      const hash = await bcrypt.hash(password, 12);
      await client.query('update users set password_hash=$1 where id=$2', [hash, user.id]);
      await client.query('update password_reset_tokens set used_at=now() where user_id=$1 and used_at is null', [user.id]);
      await endUserSessions(user.id, 'password_reset', client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

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
    // Не строка (массив, объект) раньше падала в hashToken и отвечала 500.
    if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'token required' });
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

// Повторная отправка письма БЕЗ сессии — с экрана входа.
//
// Отвечает {ok:true} всегда и одинаково, по той же причине, что и
// восстановление пароля: разный ответ на существующий и несуществующий адрес
// превращает этот маршрут в перебор учётных записей. Капчи здесь нет
// намеренно — от рассылки писем на чужой адрес защищают два ограничения:
// это по IP и двухминутная пауза на пользователя внутри issueVerification.
router.post('/resend-verification-public', async (req, res) => {
  res.json({ ok: true });

  if (!checkResendRateLimit(req.ip)) return;
  const { email } = req.body || {};
  if (typeof email !== 'string' || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return;

  try {
    const { rows } = await pool.query(
      'select id, email, email_verified_at from users where email = $1',
      [String(email).toLowerCase()]
    );
    const user = rows[0];
    if (!user || user.email_verified_at) return;
    await issueVerification(user);
  } catch (e) {
    console.error('public resend verification failed:', e.message);
  }
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated', reason: req.authReason || null });
  const notice = termsNotice.current();
  termsNotice.recordShown(pool, req.session, req.user, notice);
  res.json({
    email: req.user.email,
    role: req.user.role,
    subscriptionExpiresAt: req.user.subscription_expires_at,
    emailVerified: !!req.user.email_verified_at,
    termsAccepted: req.user.terms_version === TERMS_VERSION,
    payEnabled: xpay.enabled(),
    dashUrl: dashUrlFor(req.user),
    totpEnabled: !!req.user.totp_enabled_at,
    termsNotice: notice,
  });
});

async function logTermsAccepted(user) {
  await pool.query(
    'insert into admin_audit_log (actor_id, action, target_user_id, detail) values ($1,$2,$3,$4)',
    [user.id, 'terms_accepted', user.id, JSON.stringify({ email: user.email, version: TERMS_VERSION })]
  );
}

// Кнопка «Принимаю» в окне после входа: для учётных записей, заведённых до
// публикации правил, и для всех — после выхода новой редакции.
router.post('/accept-terms', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    await pool.query('update users set terms_version=$1, terms_accepted_at=now() where id=$2', [TERMS_VERSION, req.user.id]);
    await logTermsAccepted(req.user);
    res.json({ ok: true, termsAccepted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.canonicalEmail = canonicalEmail;
// Для дашборда администраторов (routes/dash.js): сколько учётных записей приняли действующую редакцию правил.
module.exports.TERMS_VERSION = TERMS_VERSION;
