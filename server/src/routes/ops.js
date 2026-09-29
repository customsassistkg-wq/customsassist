// Разбор находок дозора из Telegram (29.09.2026). Владелец отвечает боту — сервер запускает
// рутину Claude Code, та правит базу в ветке claude/… и присылает отчёт, владелец отвечает
// «выложи» — служба выкладки (server/ops/deploy-branch.js, от root) проверяет и выкладывает.
//
// Два входа без сессии, у каждого свой секрет (как у /api/mail/inbound):
//   POST /api/ops/telegram — webhook бота. Telegram шлёт заголовок X-Telegram-Bot-Api-Secret-Token
//     со значением, заданным при setWebhook (TELEGRAM_WEBHOOK_SECRET; scripts/telegram-webhook.js).
//     Команды принимаются только из чатов TELEGRAM_ADMIN_CHAT_IDS, остальное молча отбрасывается:
//       «разобрать» (или «добавь», «закоммить») — запуск рутины; текст для неё — сообщение, на
//         которое ответили (сводка дозора), иначе последний полный отчёт дозора; слова после
//         команды уходят рутине как пожелание владельца;
//       «выложи» — заявка на выкладку последней готовой ветки;
//       «статус» — что сейчас в работе.
//   POST /api/ops/report — отчёт рутины: заголовок x-ops-secret (OPS_REPORT_SECRET), тело
//     {status: changed | no-change | failed, branch, commit, summary}. Пересылается администраторам.
//
// Сам маршрут ничего не выкладывает и прав root не имеет: «выложи» только кладёт файл заявки.
const crypto = require('node:crypto');
const express = require('express');
const telegram = require('../services/telegram');
const ops = require('../services/ops');

const router = express.Router();

const BRANCH_RE = /^claude\/[A-Za-z0-9._/-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
// Повторное «разобрать», пока рутина работает, — не второй запуск.
const FIRE_GAP_MS = 20 * 60e3;
const PAYLOAD_MAX = 30000;
// Заслон на случай утечки секрета отчёта.
const REPORTS_PER_HOUR = 20;
let reportWindow = Date.now();
let reportsInHour = 0;

function same(given, want) {
  if (!want || typeof given !== 'string' || !given) return false;
  const h = (x) => crypto.createHash('sha256').update(x).digest();
  return crypto.timingSafeEqual(h(given), h(want));
}

// Команда — первое слово сообщения. Не \b: между кириллицей и концом строки JS границы слова не видит.
const END = '(?=$|[\\s.,!?:;])';
const COMMANDS = [
  ['fix', new RegExp('^(разобрать|разбери|добавь|закоммить|fix)' + END)],
  ['deploy', new RegExp('^(выложи|выкладывай|deploy)' + END)],
  ['status', new RegExp('^(статус|status)' + END)],
];
function command(text) {
  const t = String(text || '').trim().toLowerCase().replace(/^\//, '').replace(/^([a-zа-яё]+)@\w+/, '$1');
  for (const [name, re] of COMMANDS) if (re.test(t)) return { name, rest: t.replace(re, '').trim() };
  return null;
}

async function fireRoutine(text) {
  const res = await fetch(process.env.ROUTINE_FIRE_URL, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.ROUTINE_TOKEN,
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text: String(text).slice(0, PAYLOAD_MAX) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`рутина ответила ${res.status}${data && data.error && data.error.message ? ': ' + String(data.error.message).slice(0, 200) : ''}`);
  return String(data.claude_code_session_url || '');
}

const esc = telegram.esc;
const when = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');

async function onFix(msg, chatId, rest) {
  if (!ops.routineEnabled()) return telegram.sendTo(chatId, 'Разбор из Telegram не настроен: на сервере нет адреса или ключа рутины (ROUTINE_FIRE_URL, ROUTINE_TOKEN).');
  const s = ops.state();
  if (s.fire && Date.now() - Date.parse(s.fire.at) < FIRE_GAP_MS && !(s.report && s.report.at > s.fire.at)) {
    return telegram.sendTo(chatId, `Разбор уже идёт (запущен ${esc(when(s.fire.at))}): ${esc(s.fire.url || '')}`);
  }
  const replied = msg.reply_to_message && msg.reply_to_message.text;
  const findings = replied || ops.lastWatchReport();
  if (!String(findings).trim()) return telegram.sendTo(chatId, 'Нечего разбирать: ответьте «разобрать» на сводку дозора.');
  const text = [
    replied ? 'Сводка дозора, на которую ответил владелец:' : 'Последний полный отчёт дозора источников:',
    findings,
    rest ? `\nПожелание владельца к разбору: ${rest}` : '',
  ].join('\n');
  const url = await fireRoutine(text);
  ops.setState({ fire: { at: new Date().toISOString(), url }, report: null });
  return telegram.sendTo(chatId, `🛠 Запустил разбор. Ход работы: ${esc(url || 'claude.ai/code')}\nКогда закончу — пришлю, что изменилось, и спрошу про выкладку.`);
}

function onDeploy(chatId) {
  const r = ops.state().report;
  if (!r || r.status !== 'changed') return telegram.sendTo(chatId, 'Выкладывать нечего: готового разбора с изменениями нет.');
  const done = ops.readJson('deploy-result.json');
  if (done && done.commit === r.commit && done.ok) return telegram.sendTo(chatId, `Уже выложено: коммит <code>${esc(r.commit.slice(0, 7))}</code>.`);
  if (ops.exists('deploy-request.json') || ops.exists('deploy-request.json.processing')) return telegram.sendTo(chatId, 'Выкладка уже идёт — сервер ответит, когда закончит.');
  ops.writeJson('deploy-request.json', { branch: r.branch, commit: r.commit, at: new Date().toISOString(), chat: String(chatId) });
  return telegram.sendTo(chatId, `🚀 Выкладываю ветку <code>${esc(r.branch)}</code> (коммит <code>${esc(r.commit.slice(0, 7))}</code>). Сервер проверит файлы и тесты и ответит.`);
}

function onStatus(chatId) {
  const s = ops.state();
  const d = ops.readJson('deploy-result.json');
  const lines = ['<b>Разбор находок</b>'];
  lines.push(`Запуск рутины: ${s.fire ? esc(when(s.fire.at)) + (s.fire.url ? ' — ' + esc(s.fire.url) : '') : 'не было'}`);
  lines.push(`Отчёт: ${s.report ? esc(when(s.report.at)) + ', ' + esc(s.report.status) + (s.report.branch ? ', ветка ' + esc(s.report.branch) : '') : 'нет'}`);
  if (ops.exists('deploy-request.json') || ops.exists('deploy-request.json.processing')) lines.push('Выкладка: идёт');
  else lines.push(`Последняя выкладка: ${d ? esc(when(d.at)) + (d.ok ? ', выложено ' : ', отказ ') + esc(String(d.commit || '').slice(0, 7)) : 'не было'}`);
  if (!ops.routineEnabled()) lines.push('Рутина на сервере не настроена.');
  return telegram.sendTo(chatId, lines.join('\n'));
}

router.post('/telegram', async (req, res) => {
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(503).json({ error: 'not configured' });
  if (!same(req.get('x-telegram-bot-api-secret-token'), process.env.TELEGRAM_WEBHOOK_SECRET)) return res.status(403).json({ error: 'forbidden' });
  // Telegram ждёт быстрый ответ и повторяет доставку при ошибке; в чат отвечаем отдельным sendMessage.
  res.json({ ok: true });
  const msg = req.body && req.body.message;
  if (!msg || !msg.chat || !telegram.chatIds().includes(String(msg.chat.id))) return;
  const cmd = command(msg.text);
  if (!cmd) return;
  const chatId = String(msg.chat.id);
  try {
    if (cmd.name === 'fix') await onFix(msg, chatId, cmd.rest);
    else if (cmd.name === 'deploy') await onDeploy(chatId);
    else await onStatus(chatId);
  } catch (err) {
    console.error('ops: ' + err.message);
    await telegram.sendTo(chatId, 'Не получилось: ' + esc(err.message));
  }
});

router.post('/report', (req, res) => {
  if (!process.env.OPS_REPORT_SECRET) return res.status(503).json({ error: 'not configured' });
  if (!same(req.get('x-ops-secret'), process.env.OPS_REPORT_SECRET)) return res.status(403).json({ error: 'forbidden' });
  const now = Date.now();
  if (now - reportWindow > 3600e3) { reportWindow = now; reportsInHour = 0; }
  if (++reportsInHour > REPORTS_PER_HOUR) return res.status(429).json({ error: 'too many reports' });

  const { status, branch, commit, summary } = req.body || {};
  if (!['changed', 'no-change', 'failed'].includes(status)) return res.status(400).json({ error: 'bad status' });
  if (status === 'changed' && (!BRANCH_RE.test(String(branch)) || !SHA_RE.test(String(commit)))) return res.status(400).json({ error: 'bad branch or commit' });
  const text = String(summary || '').slice(0, 3000);
  ops.setState({ report: { status, branch: status === 'changed' ? branch : null, commit: status === 'changed' ? commit : null, summary: text, at: new Date().toISOString() } });

  const lines = status === 'changed'
    ? ['🛠 <b>Разбор готов</b>', esc(text), '', `Ветка <code>${esc(branch)}</code>, коммит <code>${esc(commit.slice(0, 7))}</code>.`, 'Ответьте «выложи» — сервер проверит файлы и тесты и выложит.']
    : status === 'no-change'
      ? ['✅ <b>Разбор: менять нечего</b>', esc(text)]
      : ['⚠️ <b>Разбор не удался</b>', esc(text)];
  telegram.notify(lines.join('\n'));
  res.json({ ok: true });
});

module.exports = router;
module.exports.command = command;
