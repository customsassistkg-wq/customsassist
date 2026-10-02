// Дашборд администраторов (dash.customsassist.trade).
//
//   GET /api/dash.js    — код интерфейса дашборда (private/dash.js), только администратору
//   GET /api/dash/data  — одна сводка на всё: процесс, база данных, systemd, сертификаты,
//                         внешние справочники, правовая база, запросы, пользователи,
//                         лимиты /api/engine, AI-помощник, журнал администрирования.
//
// Страница server/dash/index.html держит только вход и пустой каркас; всё, что показывает
// цифры, приходит отсюда и требует роли admin (middleware/requireAdmin). Каждый раздел
// собирается отдельно и падает отдельно: {error} вместо данных, а не 500 на весь дашборд.
// Ничего нового не журналируется — читаются таблицы, счётчики в памяти и состояние служб.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const express = require('express');
const { pool } = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const metrics = require('../services/metrics');
const base = require('../services/base');
const nbkr = require('../services/nbkrRates');
const classDecisions = require('../services/classDecisions');
const turnstile = require('../services/turnstile');
const engine = require('./engine');
const assistant = require('./assistant');
const auth = require('./auth');

const TZ = 6 * 3600e3; // Бишкек, UTC+6 без перехода на летнее время
const ymd = (d) => new Date(d.getTime() + TZ).toISOString().slice(0, 10);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Раздел, который не собрался, отдаёт {error} — дашборд покажет «недоступно» в своей карточке.
async function section(name, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error('dash:', name, err.message);
    return { error: err.message };
  }
}

// ── Процесс и машина ────────────────────────────────────────────────────────────
async function systemSection() {
  const mem = process.memoryUsage();
  let disk = null;
  try {
    const st = await fs.promises.statfs(process.platform === 'win32' ? path.parse(__dirname).root : '/');
    disk = { total: st.bsize * st.blocks, free: st.bsize * st.bavail };
  } catch (e) { disk = null; }
  return {
    node: process.version, platform: process.platform, pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), uptimeS: Math.round(process.uptime()),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    os: { hostname: os.hostname(), load: os.loadavg().map((v) => Math.round(v * 100) / 100), totalMem: os.totalmem(), freeMem: os.freemem(), uptimeS: Math.round(os.uptime()) },
    disk,
    base: { ...base.info },
  };
}

// ── База данных ─────────────────────────────────────────────────────────────────
async function dbSection() {
  const t0 = Date.now();
  await pool.query('select 1');
  const latencyMs = Date.now() - t0;
  const [ver, size, counts, sessions] = await Promise.all([
    pool.query('select version() as v'),
    pool.query('select pg_database_size(current_database())::float8 as bytes'),
    pool.query(`select (select count(*) from users)::int as users, (select count(*) from assistant_log)::int as assistant_log,
                       (select count(*) from admin_audit_log)::int as admin_audit_log, (select count(*) from "session")::int as sessions`),
    pool.query(`select count(*) filter (where expire > now() and sess ->> 'userId' is not null)::int as active,
                       count(*) filter (where expire > now() and sess ->> 'userId' is not null and sess ->> 'dash' = 'true')::int as dash,
                       count(*) filter (where expire <= now())::int as expired
                  from "session"`),
  ]);
  const version = String((ver.rows[0] || {}).v || '').match(/PostgreSQL [\d.]+/);
  return { latencyMs, version: version ? version[0] : null, sizeBytes: (size.rows[0] || {}).bytes || null,
    counts: counts.rows[0] || null, sessions: sessions.rows[0] || null };
}

// ── systemd: сама служба, ночной бэкап ───────────────────────────────────────────
function systemctlShow(unit, props) {
  return new Promise((resolve) => {
    if (process.platform !== 'linux') return resolve(null);
    execFile('systemctl', ['show', unit, '-p', props.join(',')], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = {};
      for (const line of String(stdout).split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
      }
      resolve(out);
    });
  });
}
// «Tue 2026-09-22 03:31:49 UTC» → ISO; пустое и «n/a» → null.
function sdTime(s) {
  const m = /(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (\S+)/.exec(String(s || ''));
  if (!m) return null;
  const d = m[3] === 'UTC' ? new Date(`${m[1]}T${m[2]}Z`) : new Date(`${m[1]} ${m[2]} ${m[3]}`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
// Метка последнего вывоза копий: одна строка ISO-времени. Лежит в /var/lib/tnved, а не рядом с дампами: каталог дампов принадлежит postgres и закрыт (700), служба работает под tnved и прочитать его не может.
function pullMark() {
  try {
    const at = new Date(fs.readFileSync('/var/lib/tnved/last-pull', 'utf8').trim());
    return isNaN(at.getTime()) ? null : { at: at.toISOString() };
  } catch (e) {
    return null; // метки нет: вывоз ещё ни разу не отмечался
  }
}
async function systemdSection() {
  const [api, backup, timer] = await Promise.all([
    systemctlShow('tnved.service', ['ActiveState', 'SubState', 'NRestarts', 'ActiveEnterTimestamp']),
    systemctlShow('tnved-db-backup.service', ['Result', 'ActiveState', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp', 'ExecMainStatus']),
    systemctlShow('tnved-db-backup.timer', ['ActiveState', 'NextElapseUSecRealtime', 'LastTriggerUSec']),
  ]);
  if (!api && !backup && !timer) return null; // не Linux или systemctl недоступен
  return {
    // Вывоз копий на машину владельца: сам вывоз делает её задача (server/pull-db-backups.ps1),
    // сервер о нём знает только по метке, которую она пишет после удачной выгрузки. Без метки
    // сломанный вывоз не виден ниоткуда: 22.09.2026 задача была убита по десятиминутному лимиту,
    // и копия за сутки не уехала — заметить это удалось случайно.
    pull: pullMark(),
    api: api && { active: api.ActiveState, sub: api.SubState, restarts: Number(api.NRestarts) || 0, since: sdTime(api.ActiveEnterTimestamp) },
    backup: backup && { result: backup.Result, active: backup.ActiveState, lastStart: sdTime(backup.ExecMainStartTimestamp),
      lastExit: sdTime(backup.ExecMainExitTimestamp), exitStatus: backup.ExecMainStatus },
    timer: timer && { active: timer.ActiveState, next: sdTime(timer.NextElapseUSecRealtime), last: sdTime(timer.LastTriggerUSec) },
  };
}

// ── Сертификаты: сайт и дашборд ─────────────────────────────────────────────────
function certHosts() {
  const hosts = [];
  for (const raw of [(process.env.APP_ORIGIN || '').split(',')[0], process.env.DASH_ORIGIN || '']) {
    try {
      const u = new URL(raw.trim());
      if (u.protocol === 'https:' && !hosts.includes(u.hostname)) hosts.push(u.hostname);
    } catch (e) { /* пусто или не URL */ }
  }
  return hosts;
}
async function certsSection() {
  const hosts = certHosts();
  return Promise.all(hosts.map((h) => metrics.certInfo(h)));
}

// ── Внешние справочники и настроенные службы ─────────────────────────────────────
function servicesSection() {
  return {
    nbkr: nbkr.status(),
    classDecisions: classDecisions.status(),
    ai: { configured: Boolean(process.env.AI_API_KEY), model: process.env.AI_MODEL || 'deepseek-chat',
      inFlight: assistant.inFlight.size, budgetUsd: assistant.DAILY_BUDGET_USD, plans: assistant.PLANS },
    ocr: { vision: Boolean(process.env.OCR_GOOGLE_SA), documentAi: Boolean(process.env.OCR_DOCAI_PROCESSOR) },
    turnstile: { enabled: turnstile.isEnabled() },
    mail: { configured: Boolean(process.env.RESEND_API_KEY), from: process.env.RESEND_FROM_EMAIL || null },
    origins: { app: (process.env.APP_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean), dash: process.env.DASH_ORIGIN || null },
    engineLimits: engine.LIMITS,
  };
}

// ── Правовая база: сверка источников и датированные меры ─────────────────────────
// База меняется только выкладкой (перезапуском), поэтому раздел считается один раз на процесс.
let baseCache = null;
function baseSection() {
  if (baseCache) return baseCache;
  const b = base.load();
  const audit = Object.entries(b.SOURCE_AUDIT).map(([key, a]) => ({ key, name: a.n, st: a.st, d: a.d || null, url: a.u || null }));
  const counts = { ok: 0, part: 0, old: 0 };
  let last = '';
  for (const a of audit) {
    if (counts[a.st] !== undefined) counts[a.st]++;
    const m = /^(\d\d)\.(\d\d)\.(\d{4})$/.exec(a.d || '');
    if (m && m[3] + '-' + m[2] + '-' + m[1] > last) last = m[3] + '-' + m[2] + '-' + m[1];
  }
  const dated = [];
  for (const e of b.BAN_DB) {
    for (const side of ['im', 'ex']) {
      if (!e[side]) continue;
      const from = e[side + 'From'] || null, until = e[side + 'Until'] || null;
      if (!from && !until) continue;
      dated.push({ kind: 'Запрет', dir: side === 'im' ? 'ввоз' : 'вывоз', name: e.name || (e.codes || []).join(', '), from, until, unver: Boolean(e.unver) });
    }
  }
  for (const rec of b.ANTIDUMP_DB) {
    if (rec[6]) dated.push({ kind: 'Антидемпинг', dir: 'ввоз', name: `${rec[2]} (${rec[1]})`, from: null, until: rec[6], unver: false });
  }
  for (const [cty, from] of Object.entries(b.LK_IN_FORCE)) {
    dated.push({ kind: 'Соглашение', dir: 'ставки', name: cty, from, until: null, unver: false });
  }
  baseCache = {
    ett: b.ETT_DB.length, tnvedMap: Object.keys(b.TNVED_MAP).length, bans: b.BAN_DB.length, antidump: b.ANTIDUMP_DB.length,
    unimeasAsOf: b.UNIMEAS_ASOF, audit: { rev: b.AUDIT_REV, counts, last: last || null, rows: audit }, dated,
  };
  return baseCache;
}

// ── Пользователи ───────────────────────────────────────────────────────────────
async function usersSection() {
  const termsVersion = auth.TERMS_VERSION;
  const [overview, byDay, recent, expiring, tokens] = await Promise.all([
    pool.query(
      `select count(*)::int as total,
              count(*) filter (where active)::int as active,
              count(*) filter (where not active)::int as disabled,
              count(*) filter (where role = 'admin' and active)::int as admins,
              count(*) filter (where email_verified_at is null)::int as unverified,
              count(*) filter (where last_seen_at > now() - interval '5 minutes')::int as online,
              count(*) filter (where last_seen_at > now() - interval '1 day')::int as seen_day,
              count(*) filter (where last_seen_at > now() - interval '7 days')::int as seen_week,
              count(*) filter (where last_seen_at > now() - interval '30 days')::int as seen_month,
              count(*) filter (where created_at > now() - interval '7 days')::int as new_week,
              count(*) filter (where created_at > now() - interval '30 days')::int as new_month,
              count(*) filter (where role <> 'admin' and active and subscription_expires_at is not null and subscription_expires_at < now())::int as expired,
              count(*) filter (where role <> 'admin' and active and subscription_expires_at >= now() and subscription_expires_at < now() + interval '7 days')::int as expiring_week,
              count(*) filter (where role <> 'admin' and active and subscription_expires_at is null)::int as unlimited,
              count(*) filter (where terms_version = $1)::int as terms_current,
              count(*) filter (where ai_plan = 'base')::int as plan_base,
              count(*) filter (where ai_plan = 'pro')::int as plan_pro,
              count(*) filter (where ai_plan = 'max')::int as plan_max
         from users`, [termsVersion]),
    pool.query(
      `select to_char(created_at + interval '6 hours', 'YYYY-MM-DD') as d, count(*)::int as n
         from users where created_at >= now() - interval '30 days' group by 1 order by 1`),
    pool.query(
      `select email, role, ai_plan, last_seen_at, last_login_at, created_at, subscription_expires_at,
              (last_seen_at > now() - interval '5 minutes') as online
         from users where last_seen_at is not null order by last_seen_at desc limit 12`),
    pool.query(
      `select email, subscription_expires_at, active
         from users
        where role <> 'admin' and subscription_expires_at is not null
          and subscription_expires_at between now() - interval '3 days' and now() + interval '14 days'
        order by subscription_expires_at limit 20`),
    pool.query(
      `select 'verify' as kind,
              count(*) filter (where used_at is null and expires_at > now())::int as pending,
              count(*) filter (where used_at > now() - interval '7 days')::int as used_week,
              count(*) filter (where used_at is null and expires_at <= now() and created_at > now() - interval '7 days')::int as expired_week
         from email_verification_tokens
       union all
       select 'reset',
              count(*) filter (where used_at is null and expires_at > now())::int,
              count(*) filter (where used_at > now() - interval '7 days')::int,
              count(*) filter (where used_at is null and expires_at <= now() and created_at > now() - interval '7 days')::int
         from password_reset_tokens`),
  ]);
  const tk = {};
  for (const r of tokens.rows) tk[r.kind] = { pending: r.pending, usedWeek: r.used_week, expiredWeek: r.expired_week };
  return { termsVersion, overview: overview.rows[0] || null, byDay: byDay.rows, recent: recent.rows, expiring: expiring.rows, tokens: tk };
}

// ── Лимиты /api/engine: счётчики сегодняшнего дня из памяти routes/engine.js ─────
async function engineSection() {
  const today = ymd(new Date());
  const now = Date.now();
  const rows = [];
  for (const [id, u] of engine.usage) {
    if (u.day !== today) continue;
    rows.push({ id, calls: u.calls, keys: u.keys.size, minuteCalls: now - u.minuteStart < 60e3 ? u.minuteCalls : 0, alerted: [...u.alerted] });
  }
  rows.sort((a, b) => b.keys - a.keys || b.calls - a.calls);
  const top = rows.slice(0, 15);
  const ids = top.map((r) => r.id).filter((id) => UUID_RE.test(id));
  const emails = new Map();
  if (ids.length) {
    const { rows: users } = await pool.query('select id, email from users where id = any($1::uuid[])', [ids]);
    for (const u of users) emails.set(u.id, u.email);
  }
  return { limits: engine.LIMITS, accounts: rows.length, calls: rows.reduce((s, r) => s + r.calls, 0),
    rows: top.map((r) => ({ email: emails.get(r.id) || null, calls: r.calls, keys: r.keys, minuteCalls: r.minuteCalls, alerted: r.alerted })) };
}

// ── AI-помощник ────────────────────────────────────────────────────────────────
async function assistantSection() {
  const month = assistant.bishkekMonth(), day = assistant.bishkekDay();
  const [totals, byDay, top, errors] = await Promise.all([
    pool.query(
      `select count(*) filter (where kind = 'question' and created_at >= $2)::int as q_today,
              count(*) filter (where kind = 'read' and created_at >= $2)::int as p_today,
              count(*) filter (where error is not null and created_at >= $2)::int as e_today,
              coalesce(sum(cost_usd) filter (where created_at >= $2), 0)::float as cost_today,
              count(*) filter (where kind = 'question')::int as q_month,
              count(*) filter (where kind = 'read')::int as p_month,
              count(*) filter (where error is not null)::int as e_month,
              coalesce(sum(cost_usd), 0)::float as cost_month,
              coalesce(sum(input_tokens), 0)::float as input_tokens,
              coalesce(sum(cache_read_tokens), 0)::float as cache_tokens,
              coalesce(sum(output_tokens), 0)::float as output_tokens,
              count(*) filter (where rating = 1)::int as good,
              count(*) filter (where rating = -1)::int as bad,
              count(distinct user_id)::int as users,
              avg(duration_ms) filter (where kind = 'question' and error is null)::int as avg_ms
         from assistant_log where created_at >= $1`, [month.start, day.start]),
    pool.query(
      `select to_char(created_at + interval '6 hours', 'YYYY-MM-DD') as d,
              count(*) filter (where kind = 'question')::int as questions,
              count(*) filter (where kind = 'read')::int as pages,
              count(*) filter (where error is not null)::int as errors,
              round(sum(cost_usd), 4)::float as cost
         from assistant_log where created_at >= now() - interval '30 days' group by 1 order by 1`),
    pool.query(
      `select u.email, u.ai_plan, count(*) filter (where l.kind = 'question')::int as questions,
              count(*) filter (where l.kind = 'read')::int as pages, count(*) filter (where l.error is not null)::int as errors,
              round(sum(l.cost_usd), 4)::float as cost, max(l.created_at) as last_at
         from assistant_log l join users u on u.id = l.user_id
        where l.created_at >= $1 group by u.email, u.ai_plan order by cost desc nulls last limit 8`, [month.start]),
    pool.query(
      `select l.created_at, u.email, l.kind, left(l.error, 200) as error
         from assistant_log l join users u on u.id = l.user_id
        where l.error is not null order by l.created_at desc limit 8`),
  ]);
  const t = totals.rows[0] || {};
  return {
    budgetUsd: assistant.DAILY_BUDGET_USD, inFlight: assistant.inFlight.size,
    today: { questions: t.q_today || 0, pages: t.p_today || 0, errors: t.e_today || 0, cost: t.cost_today || 0 },
    month: { start: ymd(month.start), questions: t.q_month || 0, pages: t.p_month || 0, errors: t.e_month || 0, cost: t.cost_month || 0,
      inputTokens: t.input_tokens || 0, cacheTokens: t.cache_tokens || 0, outputTokens: t.output_tokens || 0,
      good: t.good || 0, bad: t.bad || 0, users: t.users || 0, avgMs: t.avg_ms || null },
    byDay: byDay.rows, top: top.rows, errors: errors.rows,
  };
}

// ── Экономика: оплаты, постоянные расходы, расход API — за месяц по Бишкеку и по людям ──
// Расход на модель и Document AI — из assistant_log (cost_usd; Document AI — чтения по 3 цента);
// Vision в журнал не пишется: первая тысяча страниц в месяц у Google бесплатна, дальше — оценка
// по числу прочитанных страниц. Курс для перевода долларов в сомы — НБКР (services/nbkrRates).
const VISION_USD = Number(process.env.OCR_VISION_PRICE || 0.0015);
const VISION_FREE = 1000;
const DOCAI_USD = Number(process.env.OCR_DOCAI_PRICE || 0.03);
async function economySection() {
  const month = assistant.bishkekMonth();
  const [pay, payByMonth, recent, exp, api, users] = await Promise.all([
    pool.query(`select currency, coalesce(sum(amount), 0)::float as sum, count(*)::int as n
                  from payments where created_at >= $1 and created_at < $2 group by currency`, [month.start, month.next]),
    pool.query(`select to_char(created_at + interval '6 hours', 'YYYY-MM') as m, currency, sum(amount)::float as sum, count(*)::int as n
                  from payments where created_at >= now() - interval '12 months' group by 1, 2 order by 1`),
    pool.query(`select id, email, amount::float as amount, currency, plan, months, paid_until::text as paid_until, method, created_at
                  from payments order by created_at desc limit 10`),
    pool.query(`select id, name, amount::float as amount, currency, period, starts_on::text as starts_on, ends_on::text as ends_on, note
                  from expenses where starts_on < $2 and (ends_on is null or ends_on >= $1) order by amount desc, id`,
      [ymd(month.start), ymd(month.next)]),
    pool.query(`select coalesce(sum(cost_usd), 0)::float as total,
                       count(*) filter (where kind = 'read' and cost_usd >= $3)::int as docai,
                       count(*) filter (where kind = 'read' and error is null)::int as pages,
                       count(*) filter (where kind = 'question')::int as questions
                  from assistant_log where created_at >= $1 and created_at < $2`, [month.start, month.next, DOCAI_USD]),
    pool.query(`select u.email, u.ai_plan, u.subscription_expires_at, u.active,
                       coalesce(p.total, 0)::float as paid_total, coalesce(p.month, 0)::float as paid_month, p.last_at as last_paid,
                       coalesce(l.cost, 0)::float as cost_total, coalesce(l.cost_month, 0)::float as cost_month,
                       coalesce(l.q_month, 0)::int as q_month, coalesce(l.p_month, 0)::int as p_month
                  from users u
                  left join (select user_id, sum(amount) as total, sum(amount) filter (where created_at >= $1) as month, max(created_at) as last_at
                               from payments where currency = 'KGS' group by user_id) p on p.user_id = u.id
                  left join (select user_id, sum(cost_usd) as cost, sum(cost_usd) filter (where created_at >= $1) as cost_month,
                                    count(*) filter (where kind = 'question' and created_at >= $1) as q_month,
                                    count(*) filter (where kind = 'read' and created_at >= $1) as p_month
                               from assistant_log group by user_id) l on l.user_id = u.id
                 where u.role <> 'admin' order by paid_total desc, cost_total desc`, [month.start]),
  ]);
  const a = api.rows[0] || {};
  const docaiUsd = (a.docai || 0) * DOCAI_USD;
  const visionUsd = Math.max(0, (a.pages || 0) - VISION_FREE) * VISION_USD;
  const modelUsd = Math.max(0, (a.total || 0) - docaiUsd);
  const ym = ymd(month.start).slice(0, 7);
  const monthly = (e) => (e.period === 'month' ? e.amount : e.period === 'year' ? e.amount / 12 : String(e.starts_on).slice(0, 7) === ym ? e.amount : 0);
  const fixed = {};
  for (const e of exp.rows) fixed[e.currency] = (fixed[e.currency] || 0) + monthly(e);
  const now = new Date();
  const paidUsers = users.rows.filter((u) => u.subscription_expires_at && new Date(u.subscription_expires_at) > now);
  const mrr = paidUsers.reduce((s, u) => s + ((assistant.PLANS[u.ai_plan] || assistant.PLANS.base).price || 0), 0);
  return {
    month: ym, usdRate: nbkr.status().usd || null,
    payments: { byCurrency: pay.rows, byMonth: payByMonth.rows, recent: recent.rows },
    api: { totalUsd: a.total || 0, modelUsd, docaiUsd, visionUsd, docaiPages: a.docai || 0, pages: a.pages || 0, questions: a.questions || 0, visionFree: VISION_FREE },
    fixed: { rows: exp.rows.map((e) => ({ ...e, monthly: monthly(e) })), monthlyByCurrency: fixed },
    subscriptions: {
      paid: paidUsers.length,
      unlimited: users.rows.filter((u) => !u.subscription_expires_at && u.active).length,
      expired: users.rows.filter((u) => u.subscription_expires_at && new Date(u.subscription_expires_at) <= now).length,
      mrrKgs: mrr,
    },
    plans: assistant.PLANS,
    users: users.rows,
  };
}

// ── Обращения: входящая почта info@ и ответы на неё (миграция 0015) ─────────────
async function mailSection() {
  const [totals, recent] = await Promise.all([
    pool.query(`select count(*) filter (where direction = 'in')::int as total,
                       count(*) filter (where direction = 'in' and status = 'new')::int as unread,
                       count(*) filter (where status = 'open')::int as open,
                       count(*) filter (where direction = 'in' and created_at > now() - interval '30 days')::int as month,
                       count(*) filter (where direction = 'out')::int as replies,
                       count(*) filter (where status = 'spam')::int as spam,
                       avg(extract(epoch from (answered_at - created_at))) filter (where direction = 'in' and answered_at is not null)::float as avg_reply_s,
                       max(created_at) filter (where direction = 'in') as last_at,
                       min(created_at) filter (where direction = 'in' and status in ('new', 'open')) as oldest_open
                  from inbox`),
    pool.query(`select id, direction, from_email, from_name, to_email, subject, status, created_at, answered_at,
                       jsonb_array_length(attachments)::int as attachments
                  from inbox order by created_at desc limit 10`),
  ]);
  return { ...(totals.rows[0] || {}), recent: recent.rows, configured: Boolean(process.env.MAIL_INBOUND_SECRET) };
}

// ── Журнал администрирования ───────────────────────────────────────────────────
async function auditSection() {
  const { rows } = await pool.query(
    `select a.created_at, act.email as actor, a.action, tgt.email as target, a.detail
       from admin_audit_log a
       left join users act on act.id = a.actor_id
       left join users tgt on tgt.id = a.target_user_id
      order by a.created_at desc limit 20`);
  return rows;
}

const router = express.Router();
router.use(requireAdmin);

// Вся сводка одним объектом; отдельно от маршрута, чтобы проверять на сервере против настоящей
// базы без сессии: node -e "require('dotenv').config();require('./src/routes/dash').collect('x').then(…)".
async function collect(viewer) {
  const [system, db, systemd, certs, users, engineUsage, ai, audit, legal, economy, mail] = await Promise.all([
    section('system', systemSection),
    section('db', dbSection),
    section('systemd', systemdSection),
    section('certs', certsSection),
    section('users', usersSection),
    section('engine', engineSection),
    section('assistant', assistantSection),
    section('audit', auditSection),
    section('base', async () => baseSection()),
    section('economy', economySection),
    section('mail', mailSection),
  ]);
  return { now: new Date().toISOString(), viewer, system, db, systemd, certs, services: servicesSection(),
    base: legal, http: metrics.snapshot(), users, engine: engineUsage, assistant: ai, audit, economy, mail };
}

router.get('/data', async (req, res, next) => {
  try {
    const data = await collect(req.user.email);
    res.set('Cache-Control', 'private, no-store');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Код интерфейса дашборда — как /api/checker.js (routes/checker.js), но только администратору.
function script(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  if (!req.user) return res.status(401).json({ error: 'not authenticated', reason: req.authReason || null });
  if (req.user.role !== 'admin' || !req.user.active) return res.status(403).json({ error: 'forbidden' });
  res.set('Cache-Control', 'private, no-cache, must-revalidate');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '../../private/dash.js'), { cacheControl: false, lastModified: false }, (err) => {
    if (err) next(err);
  });
}

module.exports = { router, script, collect, baseSection, sdTime, systemSection, systemdSection, certsSection }; // три последних читает и services/health.js
