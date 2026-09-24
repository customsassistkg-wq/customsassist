// Оплата подписки по динамическому QR через xPay (24.09.2026).
//
// Платит тот, кто вошёл, или тот, чья подписка истекла: вход с верным паролем и истёкшим
// сроком не создаёт сессию, но оставляет в ней payUserId на час (routes/auth.js) — этого
// хватает только на маршруты ниже. Сумму считает сервер по PLANS; оплату засчитывает только
// settle(), которая сама спрашивает xPay: webhook, опрос из окна оплаты и фоновая сверка лишь
// будят её, поэтому подделанный webhook не даёт ничего, кроме лишнего запроса статуса.
const express = require('express');
const { pool } = require('../db');
const xpay = require('../services/xpay');
const telegram = require('../services/telegram');
const { PLANS } = require('./assistant');
const { extendedUntil } = require('./admin');

const router = express.Router();
const MONTHS = [1, 3, 6, 12];
const ORDER_REUSE_MS = 30 * 60e3;   // тот же тариф и срок в течение получаса — тот же QR
const ORDERS_PER_HOUR = 6;
const RECONCILE_MS = 5 * 60e3;
const RECONCILE_WINDOW = '2 days';

function publicOrigin() {
  return (process.env.PUBLIC_ORIGIN || (process.env.APP_ORIGIN || '').split(',')[0]).trim().replace(/\/+$/, '');
}

async function payer(req) {
  if (req.user) return req.user;
  const s = req.session;
  if (!s || !s.payUserId || !(s.payUntil > Date.now())) return null;
  const { rows } = await pool.query('select id, email, role, active, subscription_expires_at, ai_plan from users where id = $1', [s.payUserId]);
  return rows[0] && rows[0].active ? rows[0] : null;
}

function priced(plan) {
  const p = PLANS[plan];
  return p && Number(p.price) > 0 ? p : null;
}

// Засчитывает заказ, если xPay говорит COMPLETED и сумма совпадает. Повтор безопасен: заказ
// переходит из 'waiting' один раз (update ... where status = 'waiting' returning).
const lastCheck = new Map();
async function settle(orderId) {
  const { rows: [o] } = await pool.query('select * from pay_orders where id = $1', [orderId]);
  if (!o || o.status !== 'waiting' || !o.qr_transaction_id) return o || null;
  // Не чаще раза в 2 с на заказ: webhook без подписи может прийти кем угодно и сколько угодно.
  const now = Date.now();
  if (now - (lastCheck.get(o.id) || 0) < 2000) return o;
  lastCheck.set(o.id, now);
  if (lastCheck.size > 5000) lastCheck.clear();

  const st = await xpay.qrStatus(o.qr_transaction_id);
  const ps = String(st.pay_status || '');
  if (ps !== 'COMPLETED') {
    const final = ps === 'ERROR' || ps === 'CANCELED';
    const { rows: [u] } = await pool.query(
      "update pay_orders set xpay_status = $2, status = case when $3 then 'failed' else status end where id = $1 and status = 'waiting' returning *",
      [o.id, ps, final]);
    return u || o;
  }
  const paidTyiyn = Number(st.amount);
  const expected = Math.round(Number(o.amount) * 100);
  if (paidTyiyn !== expected) {
    console.error(`pay: order ${o.id} completed with amount ${st.amount}, expected ${expected}`);
    telegram.notify(`⚠️ <b>Оплата с другой суммой</b>\nЗаказ ${o.id}, ${telegram.esc(o.email)}: ждали ${expected / 100} сом, xPay сообщает ${Number(st.amount) / 100}. Подписка не продлена — разберитесь вручную.`);
    const { rows: [u] } = await pool.query(
      "update pay_orders set xpay_status = $2, status = 'mismatch' where id = $1 and status = 'waiting' returning *", [o.id, ps]);
    return u || o;
  }
  const payable = Number.isFinite(Number(st.payable)) ? Number(st.payable) / 100 : null;
  const { rows: [claimed] } = await pool.query(
    "update pay_orders set xpay_status = $2, status = 'paid', paid_at = now(), payable = $3 where id = $1 and status = 'waiting' returning *",
    [o.id, ps, payable]);
  if (!claimed) return (await pool.query('select * from pay_orders where id = $1', [o.id])).rows[0];

  // ponytail: три запроса без транзакции; сбой между ними оставит заказ 'paid' без строки payments —
  // виден в админке как заказ без payment_id. Транзакция — если такое хоть раз случится.
  let paidUntil = null;
  const { rows: [user] } = claimed.user_id
    ? await pool.query('select id, role, subscription_expires_at from users where id = $1', [claimed.user_id])
    : { rows: [] };
  if (user && user.role !== 'admin') paidUntil = extendedUntil(user.subscription_expires_at, claimed.months);
  const note = 'xPay ' + claimed.qr_transaction_id + (payable != null ? ', зачислено ' + payable.toFixed(2) : '');
  const { rows: [pay] } = await pool.query(
    `insert into payments (user_id, email, amount, currency, plan, months, paid_until, method, note, created_by)
     values ($1,$2,$3,'KGS',$4,$5,$6,'xPay QR',$7,null) returning id`,
    [claimed.user_id, claimed.email, claimed.amount, claimed.plan, claimed.months, paidUntil, note]);
  if (paidUntil) {
    await pool.query('update users set subscription_expires_at = $2, ai_plan = $3 where id = $1',
      [user.id, paidUntil + 'T23:59:59.999Z', claimed.plan]);
  }
  const { rows: [done] } = await pool.query('update pay_orders set payment_id = $2 where id = $1 returning *', [claimed.id, pay.id]);
  telegram.notify(`💰 <b>Оплата получена</b>\n${telegram.esc(claimed.email)} — ${Number(claimed.amount)} сом, ${telegram.esc((PLANS[claimed.plan] || {}).name || claimed.plan)} × ${claimed.months} мес.`
    + (payable != null ? `, зачислено ${payable.toFixed(2)}` : '') + (paidUntil ? `\nПодписка до ${paidUntil.split('-').reverse().join('.')}` : ''));
  return { ...done, paid_until: paidUntil };
}

function view(o) {
  return { id: o.id, status: o.status, xpay_status: o.xpay_status, plan: o.plan, months: o.months, amount: Number(o.amount),
    qr_code: o.qr_code, qr_image: o.qr_image, paid_until: o.paid_until || null };
}

router.get('/plans', async (req, res, next) => {
  try {
    if (!(await payer(req))) return res.status(401).json({ error: 'unauthorized' });
    if (!xpay.enabled()) return res.status(503).json({ error: 'payments_disabled' });
    res.json({ months: MONTHS, plans: Object.entries(PLANS).filter(([k]) => priced(k)).map(([key, p]) => ({ key, name: p.name, price: Number(p.price) })) });
  } catch (err) {
    next(err);
  }
});

router.post('/create', async (req, res, next) => {
  try {
    const u = await payer(req);
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    if (u.role === 'admin') return res.status(400).json({ error: 'admin' });
    if (!xpay.enabled()) return res.status(503).json({ error: 'payments_disabled' });
    const plan = String((req.body || {}).plan || '');
    const months = Number((req.body || {}).months);
    const p = priced(plan);
    if (!p) return res.status(400).json({ error: 'invalid plan' });
    if (!MONTHS.includes(months)) return res.status(400).json({ error: 'invalid months' });
    const amount = Number(p.price) * months;

    const { rows: recent } = await pool.query(
      "select * from pay_orders where user_id = $1 and created_at > now() - interval '1 hour' order by created_at desc", [u.id]);
    const same = recent.find((o) => o.status === 'waiting' && o.plan === plan && o.months === months
      && Number(o.amount) === amount && Date.now() - new Date(o.created_at) < ORDER_REUSE_MS && o.qr_code);
    if (same) return res.json(view(same));
    if (recent.length >= ORDERS_PER_HOUR) return res.status(429).json({ error: 'too many orders' });

    const { rows: [o] } = await pool.query(
      'insert into pay_orders (user_id, email, plan, months, amount) values ($1,$2,$3,$4,$5) returning *',
      [u.id, u.email, plan, months, amount]);
    let qr;
    try {
      qr = await xpay.createQr({
        amount: Math.round(amount * 100), orderId: o.id,
        name: 'Customs Assist ' + p.name + ' ' + months + ' мес.',
        // Webhook и check_url — только на публичный https: до локального стенда xPay не
        // достучится, а check_url без ответа запретил бы оплату вовсе.
        ...(/^https:\/\//.test(publicOrigin()) ? {
          callbackUrl: publicOrigin() + '/api/pay/callback?o=' + o.id,
          checkUrl: publicOrigin() + '/api/pay/check?o=' + o.id,
        } : {}),
        returnUrl: publicOrigin() + '/',
      });
    } catch (err) {
      console.error('pay: create qr failed:', err.message);
      await pool.query("update pay_orders set status = 'failed' where id = $1", [o.id]);
      return res.status(502).json({ error: 'xpay_unavailable' });
    }
    const { rows: [saved] } = await pool.query(
      'update pay_orders set qr_transaction_id = $2, qr_code = $3, qr_image = $4 where id = $1 returning *',
      [o.id, String(qr.qr_transaction_id), String(qr.qr_code || ''), String(qr.qr_image || '')]);
    res.status(201).json(view(saved));
  } catch (err) {
    next(err);
  }
});

router.get('/status/:id', async (req, res, next) => {
  try {
    const u = await payer(req);
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const { rows: [o] } = await pool.query('select id, user_id from pay_orders where id = $1', [id]);
    if (!o || o.user_id !== u.id) return res.status(404).json({ error: 'not found' });
    let cur;
    try {
      cur = await settle(id);
    } catch (err) {
      console.error('pay: status check failed:', err.message);
      cur = (await pool.query('select * from pay_orders where id = $1', [id])).rows[0];
    }
    if (cur.status === 'paid' && !cur.paid_until) {
      const { rows: [nu] } = await pool.query('select subscription_expires_at from users where id = $1', [u.id]);
      cur.paid_until = nu && nu.subscription_expires_at ? new Date(nu.subscription_expires_at).toISOString().slice(0, 10) : null;
    }
    res.json(view(cur));
  } catch (err) {
    next(err);
  }
});

// Картинка QR — через наш сервер: CSP страницы пускает картинки только со своего origin
// (server/nginx.conf), а имя картинок xPay в боевой среде заранее не известно. Адрес — из
// ответа xPay, сохранённый в заказе; берётся только https на *.xpay.kg.
router.get('/qr/:id', async (req, res, next) => {
  try {
    const u = await payer(req);
    if (!u) return res.status(401).end();
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).end();
    const { rows: [o] } = await pool.query('select user_id, qr_image from pay_orders where id = $1', [id]);
    if (!o || o.user_id !== u.id || !o.qr_image) return res.status(404).end();
    let url;
    try { url = new URL(o.qr_image); } catch (e) { return res.status(404).end(); }
    if (url.protocol !== 'https:' || !/(^|\.)xpay\.kg$/.test(url.hostname)) return res.status(404).end();
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\//.test(type)) return res.status(502).end();
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=1800' });
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    next(err);
  }
});

// Webhook xPay (ответ xPay 24.09.2026): приходит с одного их IP, ждёт 201 и при другом ответе
// повторяет 24 часа с растущим интервалом. Подписи нет, поэтому тело не читается и не хранится —
// в нём, кстати, имя и ИНН плательщика («comments»: Sender…); номер заказа — наш, в адресе, а
// факт оплаты берёт settle() у xPay. Не смогли спросить xPay — 502, пусть повторит.
router.post('/callback', async (req, res) => {
  const id = Number(req.query.o);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid order' });
  try {
    await settle(id);
  } catch (err) {
    console.error('pay: callback settle failed:', err.message);
    return res.status(502).json({ error: 'retry' });
  }
  res.status(201).json({ ok: true });
});

// check_url: перед оплатой xPay спрашивает нас и пускает платёж только после 201. QR у xPay
// бессрочен и отменить его нельзя (ответ xPay 24.09.2026), поэтому без этой проверки можно было
// оплатить брошенный QR через месяц — по старой цене или когда заказ уже удалён — и два QR
// одного человека подряд. Разрешаем только последний заказ пользователя, ждущий оплаты, не
// старше часа. Ответ — только «да/нет», никаких данных заказа.
const PAYABLE_MS = 60 * 60e3;
router.all('/check', async (req, res, next) => {
  try {
    const id = Number(req.query.o);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid order' });
    const { rows: [o] } = await pool.query('select id, user_id, status, created_at from pay_orders where id = $1', [id]);
    let ok = !!o && o.status === 'waiting' && Date.now() - new Date(o.created_at) < PAYABLE_MS;
    if (ok) {
      const { rows: [last] } = await pool.query('select id from pay_orders where user_id = $1 order by created_at desc, id desc limit 1', [o.user_id]);
      ok = !!last && Number(last.id) === id;
    }
    res.status(ok ? 201 : 409).json({ ok });
  } catch (err) {
    next(err);
  }
});

// Страховка на случай, если webhook не дошёл, а окно оплаты закрыли: незакрытые заказы
// последних двух суток переспрашиваются каждые 5 минут.
async function reconcile() {
  if (!xpay.enabled()) return;
  const { rows } = await pool.query(
    `select id from pay_orders where status = 'waiting' and qr_transaction_id is not null
       and created_at > now() - interval '${RECONCILE_WINDOW}' and created_at < now() - interval '1 minute' order by id`);
  for (const { id } of rows) {
    try {
      await settle(id);
    } catch (err) {
      console.error(`pay: reconcile order ${id} failed:`, err.message);
    }
  }
}

function init() {
  setInterval(() => reconcile().catch((err) => console.error('pay: reconcile failed:', err.message)), RECONCILE_MS).unref();
}

module.exports = router;
module.exports.settle = settle;
module.exports.reconcile = reconcile;
module.exports.init = init;
module.exports._lastCheck = lastCheck;
