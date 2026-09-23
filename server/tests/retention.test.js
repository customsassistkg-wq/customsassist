// node server/tests/retention.test.js
// Сроки из privacy.html исполняются (services/retention.js, миграция 0014): очистка передаёт
// время в оба запроса и считает удалённое; маршрут удаления учётной записи ставит строкам
// журнала purge_after раньше, чем delete обнулит target_user_id и связь пропадёт.
// Сам SQL проверен на восстановленной копии базы (session.md, 22.09.2026).
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.APP_ORIGIN = 'https://test.local';
process.env.SESSION_SECRET = 'local-check-only';
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;

const hash = bcrypt.hashSync('right-password', 4);
const mk = (id, email, role) => ({ id, email, password_hash: hash, role, active: true, email_verified_at: new Date(),
  subscription_expires_at: null, last_seen_at: new Date(), ai_plan: 'base', terms_version: '2026-09-18' });
const admin = mk('11111111-1111-4111-8111-111111111111', 'admin@test.local', 'admin');
const user = mk('22222222-2222-4222-8222-222222222222', 'user@test.local', 'user');
const users = [admin, user];
const queries = [];
require.cache[require.resolve('../src/db')] = { exports: { pool: { query: async (sql, args) => {
  queries.push([sql, args]);
  if (/from users where (id|email) ?= ?\$1/.test(sql)) return { rows: users.filter((u) => u.id === args[0] || u.email === args[0]) };
  if (/^delete from admin_audit_log/.test(sql)) return { rows: [], rowCount: 2 };
  if (/^delete from payments where created_at/.test(sql)) return { rows: [], rowCount: 1 };
  if (/^delete from inbox where purge_after/.test(sql)) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
} } } };
require.cache[require.resolve('connect-pg-simple')] = { exports: (session) => session.MemoryStore };

const { purgeExpired } = require('../src/services/retention');
const app = require('../src/index');

(async () => {
  // Очистка: одно и то же время в обоих запросах, счётчики из rowCount.
  const now = new Date('2034-01-01T00:00:00Z');
  const counts = await purgeExpired(now);
  assert.deepEqual(counts, { audit: 2, payments: 1, inbox: 1 });
  const [a, p, m] = queries.slice(-3);
  assert.match(a[0], /^delete from admin_audit_log where purge_after < \$1$/);
  assert.match(p[0], /date_trunc\('year', \$1::timestamptz at time zone 'Asia\/Bishkek'\) - interval '7 years'\) at time zone 'Asia\/Bishkek'/);
  // Переписка обращений — год с письма, срок стоит в самой строке (миграция 0015).
  assert.match(m[0], /^delete from inbox where purge_after < \$1$/);
  assert.deepEqual([a[1][0], p[1][0], m[1][0]], [now, now, now]);
  console.log('PASS: очистка — журнал по purge_after, оплаты с 1 января восьмого года, переписка по purge_after, время одно');

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const hdr = { 'content-type': 'application/json', origin: 'https://test.local' };
  try {
    const r0 = await fetch(base + '/api/auth/login', { method: 'POST', headers: hdr, body: JSON.stringify({ email: admin.email, password: 'right-password' }) });
    assert.equal(r0.status, 200);
    const cookie = r0.headers.get('set-cookie').split(';')[0];
    queries.length = 0;
    const r = await fetch(base + '/api/admin/users/' + user.id, { method: 'DELETE', headers: { ...hdr, cookie } });
    assert.equal(r.status, 200);
    const at = (re) => queries.findIndex(([sql]) => re.test(sql));
    const stamp = at(/^update admin_audit_log set purge_after = now\(\) \+ interval '3 years' where target_user_id = \$1$/);
    const logged = at(/insert into admin_audit_log/), del = at(/^delete from users where id=\$1/);
    assert.ok(logged >= 0 && stamp > logged && del > stamp, `порядок: журнал ${logged}, срок ${stamp}, удаление ${del}`);
    assert.equal(queries[stamp][1][0], user.id);
    console.log('PASS: удаление учётной записи — срок строкам журнала ставится до delete (и строке delete_user тоже)');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
