// Тихие поломки (02.10.2026): то, о чём владелец узнавал бы, только открыв дашборд, а дашборд он открывает редко. В тот же день
// выяснилось, что баланс у провайдера модели был нулевым пять дней и это нашлось случайно. Раз в час проверяются четыре вещи,
// которые дашборд уже показывает: диск, ночная копия базы, срок сертификата сайта и курс НБКР. О каждой беде — одно сообщение
// в Telegram в сутки, пока она не исчезнет; когда исчезла — одно «снова в порядке». Без TELEGRAM_* в .env ничего не уходит.
// В сообщениях нет данных пользователей: только состояние машины и сервисов.
//
// Пороги (LIMITS) рассчитаны так, чтобы ложно не тревожить: диск — меньше 12 % свободного (сейчас занято 16 %); копия базы — ошибка
// последнего запуска или последний удачный старше 36 часов (она ночная, раз в сутки); сертификат — меньше 14 дней (Let's Encrypt
// продлевает за 30, так что тревога значит «продление не идёт»); курс НБКР — запросы не удаются больше суток подряд (праздники
// не мешают: тот же курс, пока сайт отвечает, не считается сбоем).
const telegram = require('./telegram');
const nbkr = require('./nbkrRates');

const HOUR = 3600e3;
const LIMITS = { diskFreeFrac: 0.12, backupMaxAgeH: 36, certDays: 14, ratesFailingH: 24 };
const TITLES = {
  disk: 'Диск сервера почти заполнен',
  backup: 'Ночная копия базы не удалась',
  'backup-old': 'Ночная копия базы устарела',
  'backup-timer': 'Таймер ночной копии базы выключен',
  rates: 'Курс НБКР не обновляется',
};
const certKey = (host) => 'cert:' + host;
const title = (key) => key.startsWith('cert:') ? 'Сертификат ' + key.slice(5) + ' скоро истекает' : (TITLES[key] || key);

const gb = (n) => (n / 1073741824).toFixed(1).replace('.', ',');
const ago = (ms) => (ms < 48 * HOUR ? Math.round(ms / HOUR) + ' ч' : Math.round(ms / 24 / HOUR) + ' сут.');

// Текущие беды: [{ key, text }]. dash — источник сведений (по умолчанию routes/dash.js, где они уже собираются для дашборда);
// подмена нужна тесту. Каждая проверка отвечает за себя: сбой одной не гасит остальные.
async function issues(now = Date.now(), dash = require('../routes/dash')) {
  const out = [];
  try {
    const s = await dash.systemSection();
    if (s.disk && s.disk.total) {
      const free = s.disk.free / s.disk.total;
      if (free < LIMITS.diskFreeFrac) {
        out.push({ key: 'disk', text: `Свободно ${Math.round(free * 100)} % — ${gb(s.disk.free)} ГБ из ${gb(s.disk.total)} ГБ. Чаще всего это копии базы и журналы в /var/log; `
          + 'без места не пишется база и не создаются сессии. Освободить: du -sh /var/backups /var/log /root/deploy_backups.' });
      }
    }
  } catch (e) { console.error('health: диск', e.message); }
  try {
    const sd = await dash.systemdSection();
    if (sd && sd.backup) {
      const last = sd.backup.lastExit ? Date.parse(sd.backup.lastExit) : null;
      if (sd.backup.result && sd.backup.result !== 'success') {
        out.push({ key: 'backup', text: `Последний запуск tnved-db-backup.service закончился как «${sd.backup.result}» (код ${sd.backup.exitStatus}) в ${sd.backup.lastExit || 'неизвестное время'}. `
          + 'Смотреть: journalctl -u tnved-db-backup -n 50.' });
      } else if (last && now - last > LIMITS.backupMaxAgeH * HOUR) {
        out.push({ key: 'backup-old', text: `Последняя удачная копия — ${ago(now - last)} назад (${sd.backup.lastExit}); должна быть раз в сутки. Смотреть: systemctl list-timers tnved-db-backup, journalctl -u tnved-db-backup.` });
      }
      if (sd.timer && sd.timer.active && sd.timer.active !== 'active') {
        out.push({ key: 'backup-timer', text: `tnved-db-backup.timer в состоянии «${sd.timer.active}»: копии не будут создаваться. systemctl enable --now tnved-db-backup.timer.` });
      }
    }
  } catch (e) { console.error('health: копия базы', e.message); }
  try {
    for (const c of await dash.certsSection()) {
      if (c && typeof c.daysLeft === 'number' && c.daysLeft < LIMITS.certDays) {
        out.push({ key: certKey(c.host), text: `Сертификат ${c.host} действует ещё ${c.daysLeft} дн. (до ${String(c.validTo).slice(0, 10)}). Продление Let's Encrypt не идёт: certbot renew --dry-run, journalctl -u certbot.` });
      }
    }
  } catch (e) { console.error('health: сертификаты', e.message); }
  try {
    const r = nbkr.status();
    if (r.failingSince && now - Date.parse(r.failingSince) > LIMITS.ratesFailingH * HOUR) {
      out.push({ key: 'rates', text: `Запросы к nbkr.kg не удаются ${ago(now - Date.parse(r.failingSince))} подряд (${r.lastError ? r.lastError.message : 'ошибка'}). `
        + `Калькулятор и помощник считают по курсу от ${r.date || 'неизвестной даты'}${r.fromDisk ? ' из файла на диске' : ''}; дата курса видна в расчёте.` });
    }
  } catch (e) { console.error('health: курс НБКР', e.message); }
  return out;
}

const sentAt = new Map(); // ключ беды → когда о ней писали
const known = new Set(); // беды, о которых уже сказано и которые ещё не исчезли

// Один проход: новые беды и те, о которых молчали больше суток, — сообщением; исчезнувшие — «снова в порядке».
async function run(now = Date.now(), dash) {
  let list;
  try { list = await issues(now, dash); } catch (e) { console.error('health:', e.message); return []; }
  const keys = new Set(list.map((i) => i.key));
  for (const i of list) {
    known.add(i.key);
    if (now - (sentAt.get(i.key) || 0) < 24 * HOUR) continue;
    sentAt.set(i.key, now);
    console.error('health:', title(i.key));
    telegram.notify(`⚠️ <b>${telegram.esc(title(i.key))}</b>\n${telegram.esc(i.text)}`);
  }
  for (const k of [...known]) {
    if (keys.has(k)) continue;
    known.delete(k);
    sentAt.delete(k);
    telegram.notify(`✅ Снова в порядке: ${telegram.esc(title(k))}`);
  }
  return list;
}

function init() {
  // Первый проход — через две минуты после запуска (дать службе подняться и курсу — обновиться), дальше раз в час.
  setTimeout(() => run().catch(() => {}), 2 * 60 * 1000).unref();
  setInterval(() => run().catch(() => {}), HOUR).unref();
}

module.exports = { init, run, issues, LIMITS };
