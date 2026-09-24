// Удаление по срокам, названным в privacy.html («Где и сколько хранятся данные»), раз в сутки.
// Журнал административных действий — три года после удаления учётной записи: срок ставит
// маршрут удаления (routes/admin.js) в purge_after каждой строки о ней (миграция 0014).
// Записи об оплатах — до истечения срока исковой давности по налоговому обязательству:
// 6 лет со дня после срока уплаты налога (ст. 68 и 98 Налогового кодекса КР). Самый
// поздний срок уплаты за год — до 1 апреля следующего года (налог на прибыль — до срока
// единой декларации, ст. 242; декларация — до 1 апреля; единый налог — до 20 числа
// следующего месяца, ст. 426), поэтому давность истекает не позже 1 апреля седьмого года,
// и запись удаляется 1 января восьмого года после года оплаты (оплата 2026 года — 01.01.2034).
// ponytail: строка delete_payment об оплате уже удалённого пользователя срока не получает
// (target_user_id пуст) и остаётся; пока оплат нет — не важно, при первой такой — дать срок.
const { pool } = require('../db');

const DAY_MS = 24 * 3600e3;

async function purgeExpired(now = new Date()) {
  const audit = await pool.query('delete from admin_audit_log where purge_after < $1', [now]);
  // Год — по Бишкеку: база в UTC, и оплата, записанная 1 января до 06:00, иначе ушла бы в прошлый год.
  const payments = await pool.query(
    "delete from payments where created_at < (date_trunc('year', $1::timestamptz at time zone 'Asia/Bishkek') - interval '7 years') at time zone 'Asia/Bishkek'",
    [now]);
  // Переписка обращений — год с письма (миграция 0015), срок стоит в самой строке.
  const inbox = await pool.query('delete from inbox where purge_after < $1', [now]);
  // Заказы на оплату по QR — 90 дней (миграция 0016): учёт денег остаётся в payments.
  const orders = await pool.query("delete from pay_orders where created_at < $1::timestamptz - interval '90 days'", [now]);
  const counts = { audit: audit.rowCount || 0, payments: payments.rowCount || 0, inbox: inbox.rowCount || 0, orders: orders.rowCount || 0 };
  if (counts.audit || counts.payments || counts.inbox || counts.orders) {
    console.log(`retention: removed ${counts.audit} audit rows, ${counts.payments} payment records, ${counts.inbox} messages, ${counts.orders} pay orders`);
  }
  return counts;
}

function init() {
  const run = () => purgeExpired().catch((err) => console.error('retention purge failed:', err.message));
  run();
  setInterval(run, DAY_MS).unref();
}

module.exports = { purgeExpired, init };
