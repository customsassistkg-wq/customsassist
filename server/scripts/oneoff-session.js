// Одноразовая сессия администратора для проверки выкладки в браузере (01.10.2026). Только на сервере, от root:
//   cd /opt/tnved/server && node scripts/oneoff-session.js            — создать сессию на 10 минут
//   cd /opt/tnved/server && node scripts/oneoff-session.js drop       — удалить её и стереть файлы
// Пароль не нужен и не меняется, письма и сообщения администраторам не уходят: запись кладётся прямо в таблицу session так,
// как её кладёт express-session (значение cookie подписано SESSION_SECRET). Значение cookie пишется только в файл
// /root/oneoff-cookie (права 600) — не на экран; его забирают scp-ом на машину проверки и там подставляют в браузер как
// cookie tnved.sid. Идентификатор сессии — в /root/oneoff-sid, по нему drop находит запись. Живёт 10 минут; сессия
// настоящая, поэтому в журнал входа администратора она не попадает (входа не было) и второго фактора не касается.
// Требует ровно одного активного администратора: иначе непонятно, чью сессию создавать.
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { pool } = require('../src/db');

const DIR = process.env.ONEOFF_DIR || '/root';
const SID_FILE = path.join(DIR, 'oneoff-sid');
const COOKIE_FILE = path.join(DIR, 'oneoff-cookie');

(async () => {
  if (process.argv[2] === 'drop') {
    const sid = fs.readFileSync(SID_FILE, 'utf8').trim();
    const r = await pool.query('delete from session where sid = $1', [sid]);
    fs.rmSync(SID_FILE, { force: true });
    fs.rmSync(COOKIE_FILE, { force: true });
    console.log('dropped', r.rowCount);
  } else {
    const { rows } = await pool.query("select id from users where role = 'admin' and active order by created_at");
    if (rows.length !== 1) throw new Error('активных администраторов: ' + rows.length + ' (нужен ровно один)');
    const sid = crypto.randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + 10 * 60e3);
    const sess = { cookie: { originalMaxAge: 600000, expires: expires.toISOString(), secure: true, httpOnly: true, path: '/', sameSite: 'lax' }, userId: rows[0].id };
    await pool.query('insert into session (sid, sess, expire) values ($1, $2, $3)', [sid, sess, expires]);
    // подпись — как у cookie-signature: HMAC-SHA256 от sid, base64 без «=»
    const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '');
    fs.writeFileSync(SID_FILE, sid, { mode: 0o600 });
    fs.writeFileSync(COOKIE_FILE, encodeURIComponent('s:' + sid + '.' + sig), { mode: 0o600 });
    console.log('session created until', expires.toISOString());
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
