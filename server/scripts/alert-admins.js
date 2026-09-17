// Письмо администраторам сайта о сбое службы на сервере.
//
// Запускает systemd: у tnved-db-backup.service и tnved.service стоит
// OnFailure=tnved-alert@%n.service (шаблон — server/tnved-alert@.service).
// Сбой ночного бэкапа или окончательное падение API иначе видно только в
// `systemctl --failed`, куда никто не смотрит. Адресаты — активные
// администраторы из таблицы users; письмо идёт тем же Resend и шаблоном, что
// письма сайта.
//
// ponytail: адресаты берутся из базы, поэтому при лежащем PostgreSQL письма не
// будет; но тогда лежит и сайт, и это заметно без письма.
//
// Usage: node scripts/alert-admins.js <unit> [--dry-run]
require('dotenv').config();
const { execFileSync } = require('node:child_process');
const { pool } = require('../src/db');
const { sendEmail, renderEmail, BRAND } = require('../src/services/email');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const [unit, flag] = process.argv.slice(2);
  if (!unit) {
    console.error('Usage: node scripts/alert-admins.js <unit> [--dry-run]');
    process.exit(2);
  }
  let log;
  try {
    log = execFileSync('journalctl', ['-u', unit, '-n', '25', '--no-pager', '-o', 'short-iso'], { encoding: 'utf8' });
  } catch (err) {
    log = 'journalctl не выполнился: ' + err.message;
  }
  const { rows } = await pool.query("select email from users where role = 'admin' and active = true order by created_at");
  await pool.end();
  const to = rows.map((r) => r.email);
  const at = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek' });
  const subject = `Сбой службы ${unit} — ${BRAND}`;
  const html = renderEmail({
    title: 'Сбой службы на сервере',
    intro: `Служба <b>${esc(unit)}</b> завершилась с ошибкой (${esc(at)} по Бишкеку).`
      + ' Проверьте на сервере: <span style="font-family:monospace">systemctl status ' + esc(unit) + '</span>.',
    outro: '<b>Последние строки журнала:</b><br><span style="display:block;margin-top:6px;font-family:Consolas,Menlo,monospace;'
      + 'font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-all;background:#F4F6FA;border-radius:8px;padding:10px">'
      + esc(log.trim() || '(журнал пуст)') + '</span>',
    footNote: 'Письмо отправлено автоматически: systemd OnFailure → tnved-alert@.service.',
  });

  if (flag === '--dry-run') {
    console.log(`dry-run: unit=${unit} recipients=${to.length} journal_lines=${log.trim().split('\n').length} html_bytes=${Buffer.byteLength(html)}`);
    return;
  }
  if (!to.length) throw new Error('no active admins to alert');
  for (const addr of to) await sendEmail({ to: addr, subject, html });
  console.log(`alert sent: unit=${unit} recipients=${to.length}`);
}

main().catch((err) => {
  console.error('alert-admins failed:', err.message);
  process.exit(1);
});
