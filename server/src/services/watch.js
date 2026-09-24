// «Мои коды» (24.09.2026): пользователь следит за своими кодами ТН ВЭД, сервис раз в сутки
// сверяет, что база говорит о каждом, и пишет, если по существу что-то изменилось.
//
// Слепок кода — карточки выдачи renderHtml(code, сегодня по Бишкеку): класс карточки, её
// data-атрибуты (направление, вид, страна, частичное совпадение…), заголовок, метки и ставка
// пошлины. Подробности и блок «источник сверён…» не входят — они меняются от правки текста и
// новой сверки, а не от изменения меры. Карточка опознаётся по data-атрибутам и заголовку:
// сменился класс или метки у той же карточки — «изменилось», новой нет в старом слепке —
// «появилось», старой нет в новом — «больше не действует». Меры со сроком меняют слепок в
// день начала или окончания, выкладка базы — в день выкладки.
//
// Задача идёт раз в час и работает один раз в сутки по Бишкеку, с 9:00: строки, проверенные
// сегодня (checked_on), пропускаются, поэтому перезапуск ничего не повторит. Письмо — одно на
// пользователя со всеми его кодами; только подтверждённому, активному, с действующим доступом.
const { pool } = require('../db');
const base = require('./base');
const { sendEmail, renderEmail, BRAND } = require('./email');

const TZ = 6 * 3600e3;
const MAX_CODES = 30;
const RUN_FROM_HOUR = 9;

const todayIso = (now = new Date()) => new Date(now.getTime() + TZ).toISOString().slice(0, 10);
const origin = () => (process.env.PUBLIC_ORIGIN || (process.env.APP_ORIGIN || '').split(',')[0]).trim().replace(/\/+$/, '');
const text = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let ettIdx = null;
function ettName(code) {
  if (!ettIdx) { ettIdx = new Map(); for (const r of base.load().ETT_DB) ettIdx.set(r[0], r[1]); }
  return ettIdx.get(code);
}
function isEttCode(code) { return /^\d{10}$/.test(code) && ettName(code) !== undefined; }

function fingerprint(code, date) {
  const { html } = base.load().ENGINE_API.renderHtml(code, date);
  const out = [];
  for (const m of String(html).matchAll(/<div class="card ([^"]*)"([^>]*)>([\s\S]*?)(?=<div class="card |$)/g)) {
    const body = m[3];
    out.push({
      c: m[1],
      a: [...m[2].matchAll(/(data-[a-z-]+)="([^"]*)"/g)].map((x) => x[1] + '=' + x[2]).sort().join(' '),
      n: text((body.match(/<div class="rn"[^>]*>([\s\S]*?)<\/div>/) || [])[1]),
      t: [...body.matchAll(/<span class="tag [^"]*">([\s\S]*?)<\/span>/g)].map((x) => text(x[1])),
      r: text((body.match(/<div class="ett-rate">([\s\S]*?)<\/div>/) || [])[1]),
    });
  }
  return out;
}

// Сравнение слепков: одинаковые по data-атрибутам и заголовку карточки — одна и та же мера.
function diff(before, after) {
  const keyed = (list) => {
    const seen = {}, map = new Map();
    for (const c of list || []) { const k = c.a + '|' + c.n; seen[k] = (seen[k] || 0) + 1; map.set(k + '#' + seen[k], c); }
    return map;
  };
  const a = keyed(before), b = keyed(after);
  const added = [], removed = [], changed = [];
  for (const [k, c] of b) if (!a.has(k)) added.push(c);
  for (const [k, c] of a) {
    if (!b.has(k)) { removed.push(c); continue; }
    const n = b.get(k);
    if (c.c !== n.c || c.r !== n.r || JSON.stringify(c.t) !== JSON.stringify(n.t)) changed.push({ before: c, after: n });
  }
  return { added, removed, changed, any: !!(added.length || removed.length || changed.length) };
}

const cardLine = (c) => escHtml(c.n.length > 150 ? c.n.slice(0, 150) + '…' : c.n)
  + (c.t.length ? ' <span style="color:#5C6474">— ' + escHtml(c.t.join(', ')) + '</span>' : '')
  + (c.r ? ' <b>' + escHtml(c.r) + '</b>' : '');
function describe(code, d) {
  const fmt = code.slice(0, 4) + ' ' + code.slice(4, 6) + ' ' + code.slice(6, 9) + ' ' + code.slice(9);
  const name = ettName(code) || '';
  const li = (s) => '<li style="margin:4px 0">' + s + '</li>';
  let h = '<div style="margin:16px 0 0"><b>' + fmt + '</b> <span style="color:#5C6474">' + escHtml(name.length > 120 ? name.slice(0, 120) + '…' : name) + '</span><ul style="margin:6px 0 0;padding-left:18px">';
  for (const c of d.added) h += li('Появилось: ' + cardLine(c));
  for (const x of d.changed) h += li('Изменилось: ' + cardLine(x.after) + '<br><span style="color:#8A92A3">было: ' + escHtml(x.before.t.join(', ')) + (x.before.r ? ' ' + escHtml(x.before.r) : '') + '</span>');
  for (const c of d.removed) h += li('Больше не действует: ' + cardLine(c));
  return h + '</ul></div>';
}

let running = false;
async function run(now = new Date()) {
  if (running || new Date(now.getTime() + TZ).getUTCHours() < RUN_FROM_HOUR) return { checked: 0, mailed: 0 };
  running = true;
  const day = todayIso(now);
  let checked = 0, mailed = 0;
  try {
    const { rows } = await pool.query(
      `select w.user_id, w.code, w.snapshot, u.email, u.role, u.active, u.email_verified_at, u.subscription_expires_at
         from watched_codes w join users u on u.id = w.user_id
        where w.checked_on is null or w.checked_on < $1::date
        order by w.user_id, w.code`, [day]);
    const fpCache = new Map();
    const perUser = new Map();
    for (const w of rows) {
      if (!fpCache.has(w.code)) fpCache.set(w.code, fingerprint(w.code, day));
      const fp = fpCache.get(w.code);
      const d = w.snapshot ? diff(w.snapshot, fp) : { any: false };
      await pool.query(
        `update watched_codes set snapshot = $3, checked_on = $4::date${d.any ? ', changed_at = now()' : ''} where user_id = $1 and code = $2`,
        [w.user_id, w.code, JSON.stringify(fp), day]);
      checked++;
      const live = w.active && w.email_verified_at && (w.role === 'admin' || !w.subscription_expires_at || new Date(w.subscription_expires_at) > now);
      if (d.any && live) {
        if (!perUser.has(w.user_id)) perUser.set(w.user_id, { email: w.email, parts: [] });
        perUser.get(w.user_id).parts.push(describe(w.code, d));
      }
    }
    if (process.env.RESEND_API_KEY) {
      for (const { email, parts } of perUser.values()) {
        try {
          await sendEmail({
            to: email,
            subject: `Изменения по вашим кодам ТН ВЭД (${parts.length}) — ${BRAND}`,
            html: renderEmail({
              title: 'Изменения по вашим кодам',
              intro: 'Сервис ежедневно сверяет коды из раздела «Мои коды» с базой. Сегодня по существу изменилось:' + parts.join(''),
              actionUrl: origin() ? origin() + '/' : '',
              actionText: 'Открыть Customs Assist KG',
              outro: 'Подробности и основания — в карточках кода на сайте. Сведения справочные: перед подачей декларации сверяйтесь с официальным текстом акта.',
              footNote: 'Письмо пришло, потому что код отмечен в «Моих кодах». Убрать код из слежения — в меню аккаунта, «Мои коды».',
            }),
          });
          mailed++;
        } catch (err) {
          console.error('watch: mail failed:', err.message);
        }
      }
    }
    if (checked) console.log(`watch: checked ${checked} codes, ${perUser.size} users with changes, ${mailed} mailed`);
  } finally {
    running = false;
  }
  return { checked, mailed };
}

function init() {
  const tick = () => run().catch((err) => console.error('watch: run failed:', err.message));
  setTimeout(tick, 90e3).unref();
  setInterval(tick, 3600e3).unref();
}

module.exports = { run, init, fingerprint, diff, describe, isEttCode, ettName, todayIso, MAX_CODES };
