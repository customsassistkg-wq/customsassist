// node tools/db-rehearsal.mjs [файл-структуры]   — репетиция базы с нуля (02.10.2026).
// Одноразовый PostgreSQL 18 из пакета embedded-postgres (скачивает свой, в систему ничего не ставит; данных пользователей
// здесь нет и быть не может): все миграции server/migrations по порядку, снимок структуры тем же запросом, что и с боевой базы
// (tools/schema-probe.sql), и server/tests/reset-password.test.js на этой базе — единственный тест, которому нужна настоящая база.
//
//   mkdir /tmp/pgx && cd /tmp/pgx && npm init -y && npm i embedded-postgres@18.4.0-beta.17     # один раз
//   EMBEDDED_PG=/tmp/pgx/node_modules/embedded-postgres/dist/index.js node tools/db-rehearsal.mjs /tmp/schema-fresh.txt
//
// Структура боевой базы — по ssh, без данных:
//   ssh root@… "sudo -u postgres psql -d tnved -At -f -" < tools/schema-probe.sql > /tmp/schema-live.txt
//   diff <(LC_ALL=C sort /tmp/schema-live.txt) <(LC_ALL=C sort /tmp/schema-fresh.txt)
// На 02.10.2026 различалась одна таблица — session: её создаёт сам сервер при запуске (connect-pg-simple, createTableIfMissing);
// всё остальное — 123 столбца, 117 ограничений, 30 индексов — совпало, 19 миграций накатываются с нуля без ошибок.
// Версия PostgreSQL на сервере — 18.x; сверяйте с `psql -V` там, и если она ушла вперёд — ставьте соответствующий embedded-postgres.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const spec = process.env.EMBEDDED_PG;
const mod = await import(spec ? pathToFileURL(spec).href : 'embedded-postgres').catch((e) => {
  console.error('Нет пакета embedded-postgres: ' + e.message + '\nУстановка и запуск — в начале этого файла.');
  process.exit(2);
});
const EmbeddedPostgres = mod.default;
const out = process.argv[2] || '/tmp/schema-fresh.txt';
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ca-pg-'));
const port = Number(process.env.REHEARSAL_PORT || 54000 + Math.floor(Math.random() * 900));
const pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'x', port, persistent: false, onLog: () => {}, onError: () => {} });
let rc = 0;
await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('tnved_test');
  const c = pg.getPgClient('tnved_test');
  await c.connect();
  const files = fs.readdirSync(path.join(ROOT, 'server/migrations')).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  for (const f of files) {
    try { await c.query(fs.readFileSync(path.join(ROOT, 'server/migrations', f), 'utf8')); console.log('миграция ' + f + ' — ok'); }
    catch (e) { console.log('миграция ' + f + ' — ОШИБКА: ' + e.message); rc = 1; break; }
  }
  if (!rc) {
    const probe = fs.readFileSync(path.join(ROOT, 'tools/schema-probe.sql'), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean);
    const lines = [];
    for (const q of probe) for (const r of (await c.query(q)).rows) lines.push(Object.values(r)[0]);
    fs.writeFileSync(out, lines.join('\n') + '\n');
    console.log('структура снята: ' + lines.length + ' строк → ' + out);
  }
  await c.end();
  if (!rc) {
    const env = { ...process.env, TEST_DATABASE_URL: `postgres://postgres:x@127.0.0.1:${port}/tnved_test` };
    const t = spawnSync(process.execPath, ['tests/reset-password.test.js'], { cwd: path.join(ROOT, 'server'), env, encoding: 'utf8', timeout: 120000 });
    console.log('reset-password.test.js rc=' + t.status + ' ' + ((t.stdout || '').trim().split('\n').pop() || (t.stderr || '').trim().split('\n')[0]));
    if (t.status !== 0) rc = 1;
  }
} finally {
  await pg.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(rc);
