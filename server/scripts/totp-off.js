// Выключить второй фактор входа учётной записи — когда администратор потерял и телефон, и коды восстановления
// (01.10.2026). Только на сервере, от имени, у которого есть .env:
//   cd /opt/tnved/server && sudo -u tnved node scripts/totp-off.js admin@example.com
// Пароль не меняется; запись — в журнале администрирования (totp_disabled, via: scripts/totp-off.js), сообщение — в Telegram.
require('dotenv').config({ path: require('node:path').join(__dirname, '../.env') });
const { pool } = require('../src/db');
const telegram = require('../src/services/telegram');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Укажите адрес: node scripts/totp-off.js <email>');
    process.exit(2);
  }
  const { rows } = await pool.query(
    'update users set totp_secret = null, totp_enabled_at = null, totp_last_step = null, totp_recovery = null'
    + ' where lower(email) = $1 and totp_enabled_at is not null returning id, email', [email]);
  if (!rows.length) {
    console.log('У этого адреса второй фактор не включён (или адреса нет) — ничего не изменено.');
  } else {
    const u = rows[0];
    await pool.query('insert into admin_audit_log (actor_id, action, target_user_id, detail) values ($1,$2,$3,$4)',
      [u.id, 'totp_disabled', u.id, JSON.stringify({ email: u.email, via: 'scripts/totp-off.js' })]);
    await telegram.notifyAdmins(`🔓 <b>Второй фактор выключен на сервере</b>\n${telegram.esc(u.email)} — scripts/totp-off.js; вход снова только по паролю.`).catch(() => {});
    console.log('Второй фактор выключен:', u.email);
  }
  await pool.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
