// Разбор находок дозора из Telegram (29.09.2026). Владелец отвечает боту — сервер запускает
// рутину Claude Code, та правит базу в ветке claude/… и присылает отчёт, владелец отвечает
// «выложи» — служба выкладки (server/ops/deploy-branch.js, от root) проверяет и выкладывает.
//
// Три входа без сессии, секрет — в заголовке (как у /api/mail/inbound):
//   POST /api/ops/telegram — webhook бота. Telegram шлёт заголовок X-Telegram-Bot-Api-Secret-Token
//     со значением, заданным при setWebhook (TELEGRAM_WEBHOOK_SECRET; scripts/telegram-webhook.js).
//     Команды принимаются только из чатов TELEGRAM_ADMIN_CHAT_IDS, остальное молча отбрасывается:
//       «разобрать» (или «добавь», «закоммить»…) — запуск рутины. Ей уходит полный отчёт
//         последнего дозора (сводка в Telegram неполна: первые две находки группы), слова после
//         команды — пожелание владельца; с пожеланием можно и без отчёта («добавь постановление
//         № …»). «разобрать заново» — не дожидаясь прежнего запуска. Ответ на постороннее
//         сообщение бота рутине не уходит: в уведомлениях о регистрации и обращениях — адреса
//         пользователей, а рутина — это передача наружу;
//       «выложи» — заявка на выкладку последней готовой ветки;
//       «статус» — что сейчас в работе и что делать дальше; «помощь» — список команд.
//   POST /api/ops/report — отчёт рутины: заголовок x-ops-secret (OPS_REPORT_SECRET), тело
//     {status: changed | no-change | failed, run, branch, commit, files, summary}. Пересылается
//     администраторам. Отчёт прошлого запуска (run не тот) показывается, но не выкладывается.
//   GET /api/ops/fetch?url=… — чтение официального сайта для рутины (services/officialFetch.js),
//     тот же секрет: из облака сайты *.gov.kg не открываются, с сервера — открываются.
//
// Сам маршрут ничего не выкладывает и прав root не имеет: «выложи» только кладёт файл заявки.
const crypto = require('node:crypto');
const express = require('express');
const telegram = require('../services/telegram');
const ops = require('../services/ops');
const official = require('../services/officialFetch');

const router = express.Router();

const REPO = 'customsassistkg-wq/customsassist';
const BRANCH_RE = /^claude\/[A-Za-z0-9._/-]{1,100}$/;
// То, что git не примет именем ветки или прочтёт иначе (то же в server/ops/deploy-branch.js).
const BRANCH_BAD = /\.\.|\/\/|@\{|\/\.|[/.]$|\.lock$|\.lock\//;
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_RE = /^[0-9a-f]{12}$/;
// Пока рутина работает, повторное «разобрать» — не второй запуск: сверка с источниками идёт
// и час, и дольше, а API рутин на каждый запрос создаёт новую сессию. «Заново» — запускает.
const FIRE_GAP_MS = 90 * 60e3;
// Отчёта нет дольше этого — напомнить: рутина могла не закончить или не достучаться до сервера.
const SILENCE_MS = 60 * 60e3;
// Служба выкладки живёт не дольше TimeoutStartSec (30 минут): файл «в работе» старше — брошенный.
const DEPLOY_STALE_MS = 35 * 60e3;
const PAYLOAD_MAX = 60000; // предел API рутин — 65 536 знаков
// Заслоны на случай утечки секрета отчёта.
const REPORTS_PER_HOUR = 20;
const FETCHES_PER_HOUR = 600;

function limiter(perHour) {
  let start = Date.now();
  let n = 0;
  return () => {
    if (Date.now() - start > 3600e3) { start = Date.now(); n = 0; }
    return ++n <= perHour;
  };
}
const reportAllowed = limiter(REPORTS_PER_HOUR);
const fetchAllowed = limiter(FETCHES_PER_HOUR);

function same(given, want) {
  if (!want || typeof given !== 'string' || !given) return false;
  const h = (x) => crypto.createHash('sha256').update(x).digest();
  return crypto.timingSafeEqual(h(given), h(want));
}

// Ошибка с текстом для владельца; у прочих (сбой в коде) текст в чат не идёт.
const friendly = (message) => Object.assign(new Error(message), { friendly: true });

// Команда — первое слово сообщения (после «ну», «давай», «пожалуйста»). Не \b: между кириллицей
// и концом строки JS границы слова не видит.
const END = '(?=$|[\\s.,!?:;])';
const COMMANDS = [
  ['fix', new RegExp('^(разобрать|разбери|разберись|добавь|добавить|внеси|внести|исправь|исправить|закоммить|закоммитить|fix)' + END, 'i')],
  ['deploy', new RegExp('^(выложи|выложить|выкладывай|выкладывать|деплой|задеплой|deploy)' + END, 'i')],
  ['status', new RegExp('^(статус|состояние|status)' + END, 'i')],
  ['help', new RegExp('^(помощь|помоги|справка|команды|help|start)' + END, 'i')],
];
const LEAD = /^(ну|давай|давайте|пожалуйста|ок|окей|хорошо|ладно|тогда|да)[\s,.!]+/i;
const AGAIN = /^(заново|снова|повторно|опять|ещ[её] раз)(?=$|[\s.,!?:;])[\s.,!:;]*/i;
function command(text) {
  let t = String(text || '').trim().replace(/^\//, '').replace(/^([a-zа-яё]+)@\w+/i, '$1');
  for (let i = 0; i < 3 && LEAD.test(t); i++) t = t.replace(LEAD, '');
  for (const [name, re] of COMMANDS) {
    if (!re.test(t)) continue;
    let rest = t.replace(re, '').replace(/^[\s.,!:;—-]+/, '').trim();
    const again = name === 'fix' && AGAIN.test(rest);
    if (again) rest = rest.replace(AGAIN, '').trim();
    // Вопрос («разбор готов?») и отказ («выкладывать не надо») — не команда, что бы ни стояло первым.
    const doubt = t.includes('?') || /^не(?=$|[\s.,!?:;])/i.test(rest);
    return { name, rest, again, doubt };
  }
  return null;
}

const esc = telegram.esc;
// Время — бишкекское (UTC+6, без перевода часов): владелец читает сообщения там.
const when = (iso) => {
  if (!iso || Number.isNaN(Date.parse(iso))) return '—';
  const d = new Date(Date.parse(iso) + 6 * 3600e3).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)} в ${d.slice(11, 16)}`;
};
const ago = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60e3));
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
};

const HELP = [
  '<b>Что я умею</b>',
  '«разобрать» — Claude проверит находки дозора по официальным сайтам, подготовит правки базы и пришлёт отчёт. Можно дописать пожелание: «разобрать только квоту». Можно попросить и без дозора: «добавь постановление № …».',
  '«разобрать заново» — запустить разбор ещё раз, не дожидаясь прежнего.',
  '«выложи» — выложить на сайт правки из последнего готового разбора. Сервер сам проверит файлы и тесты.',
  '«статус» — что сейчас в работе и что делать дальше.',
].join('\n');

const reported = (s) => !!(s.fire && s.report && s.report.at > s.fire.at);
const running = (s) => !!(s.fire && !reported(s) && Date.now() - Date.parse(s.fire.at) < FIRE_GAP_MS);

function explain(status, retryAfter) {
  if (status === 400) return 'рутина не приняла запуск (400): она приостановлена на claude.ai или текст слишком длинный';
  if (status === 401) return 'токен рутины не подходит (401): его нужно выпустить заново на claude.ai и записать на сервер';
  if (status === 403) return 'у учётной записи нет доступа к рутинам (403)';
  if (status === 404) return 'рутина не найдена (404): проверьте адрес ROUTINE_FIRE_URL на сервере';
  if (status === 429) {
    const min = Math.ceil(Number(retryAfter) / 60);
    return 'исчерпан лимит запусков рутины' + (min > 0 ? ` — повторите через ${min} мин` : ' — повторите позже');
  }
  if (status >= 500) return `сервис рутин временно недоступен (${status}) — повторите через несколько минут`;
  return `сервис рутин ответил ${status}`;
}

async function fireRoutine(text) {
  let res;
  try {
    res = await fetch(process.env.ROUTINE_FIRE_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + process.env.ROUTINE_TOKEN,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    // Сам не повторяю: запрос мог дойти, а API рутин на каждый запрос создаёт новую сессию.
    if (err.name === 'TimeoutError') {
      throw Object.assign(friendly('сервис рутин не ответил за 30 секунд. Запуск мог всё же состояться — загляните на claude.ai/code; если сессии нет, через пару минут напишите «разобрать заново»'), { maybeFired: true });
    }
    throw friendly('нет связи с сервисом рутин — повторите через пару минут');
  }
  if (!res.ok) throw friendly(explain(res.status, res.headers.get('retry-after')));
  const data = await res.json().catch(() => ({}));
  return String(data.claude_code_session_url || '');
}

const SUMMARY_HEAD = /^(📋)?\s*Дозор источников/;
const REPORT_HEAD = /^(🛠|✅|⚠️|ℹ️)?\s*(Разбор готов|Разбор: менять нечего|Разбор не удался|Отчёт не от текущего запуска)/;
// Служебные сообщения самого бота: ответ на них — как сообщение без ответа (их текст рутине не нужен).
const OWN_HEAD = /^(⏳|⛔|✅|🚀|🛠|Что я умею|Не понял команду|Разбор:|Выкладывать нечего|Разбирать пока нечего|Это сообщение|Чтобы выложить|Уже выложено|Не получилось|Служба выкладки)/;

// Что уйдёт рутине: { text, label } или { refuse } — почему ничего.
function source(msg, wish) {
  const report = ops.lastWatchReport().trim();
  const date = (report.match(/^Дозор источников (\d\d\.\d\d\.\d{4})/) || [])[1];
  const label = 'отчёт дозора' + (date ? ' от ' + date : '');
  let reply = msg.reply_to_message;
  let replied = reply ? String(reply.text || reply.caption || '').trim() : '';
  if (reply && OWN_HEAD.test(replied) && !REPORT_HEAD.test(replied)) { reply = null; replied = ''; }
  if (reply && REPORT_HEAD.test(replied)) {
    const text = ['Прошлый отчёт разбора, на который ответил владелец:', replied].concat(report ? ['', 'Отчёт дозора:', report] : []).join('\n');
    return { text, label: 'прошлый отчёт разбора' + (report ? ' и ' + label : '') };
  }
  if (reply && !SUMMARY_HEAD.test(replied)) {
    return { refuse: 'Это сообщение я на разбор не отправляю: разбираю только находки дозора. Ответьте «разобрать» на сводку дозора или напишите «разобрать» отдельным сообщением.' };
  }
  if (report) return { text: report, label };
  // Сводка есть, а полного отчёта на сервере нет (дозор был до установки разбора).
  if (replied) return { text: replied, label: 'сводка дозора (неполная: полного отчёта на сервере нет)' };
  if (wish) return { text: '', label: 'только ваше пожелание (отчёта дозора на сервере нет)' };
  return { refuse: 'Разбирать пока нечего: отчёта дозора на сервере нет. Он приходит утром, когда есть находки, — ответьте на него «разобрать». Или напишите, что внести: «добавь постановление № …».' };
}

function payload(run, src, wish) {
  const head = `Запуск: ${run}\nЧто разбирать: ${src.label}\nПожелание владельца: ${wish || 'нет'}\n\n`;
  if (!src.text) return head + 'Отчёта дозора нет: разбирай только пожелание владельца.';
  // Текст извне не должен выдавать себя за рамку или за строку пожелания.
  const body = src.text.replace(/^(--- (начало|конец) ---|Запуск:|Что разбирать:|Пожелание владельца:)/gm, '· $1');
  const room = PAYLOAD_MAX - head.length - 100;
  const cut = body.length > room ? `\n(текст обрезан: ${room} знаков из ${body.length})` : '';
  return `${head}--- начало ---\n${body.slice(0, room)}\n--- конец ---${cut}`;
}

// Два «разобрать» в одну секунду (два администратора, двойное нажатие) — один запуск.
let firing = false;

async function onFix(msg, chatId, cmd) {
  if (!ops.routineEnabled()) return telegram.sendTo(chatId, 'Разбор из Telegram не настроен: на сервере нет адреса или ключа рутины (ROUTINE_FIRE_URL, ROUTINE_TOKEN).');
  if (cmd.doubt) return telegram.sendTo(chatId, 'Это похоже на вопрос или отказ, а не на команду — разбор не запускаю. Что с разбором — «статус»; запустить — «разобрать».');
  const s = ops.state();
  if (firing) return telegram.sendTo(chatId, '⏳ Разбор уже запускается — подождите минуту.');
  if (running(s) && !cmd.again) {
    return telegram.sendTo(chatId, `⏳ Разбор уже идёт ${esc(ago(s.fire.at))} (запущен ${esc(when(s.fire.at))}).${s.fire.url ? '\nХод работы: ' + esc(s.fire.url) : ''}\nДождитесь отчёта. Если он завис — напишите «разобрать заново».`);
  }
  const src = source(msg, cmd.rest);
  if (src.refuse) return telegram.sendTo(chatId, src.refuse);
  firing = true;
  try {
    const run = crypto.randomBytes(6).toString('hex');
    let url;
    try {
      url = await fireRoutine(payload(run, src, cmd.rest));
    } catch (err) {
      // Ответа не дождались, но запуск мог состояться: запомнить номер, чтобы принять его отчёт.
      if (err.maybeFired) ops.setState({ fire: { at: new Date().toISOString(), url: '', run }, report: null });
      throw err;
    }
    ops.setState({ fire: { at: new Date().toISOString(), url, run }, report: null });
    return telegram.sendTo(chatId, [
      `🛠 <b>Запустил разбор</b>: ${esc(src.label)}.`,
      cmd.rest ? `Пожелание: ${esc(cmd.rest)}` : null,
      `Ход работы: ${esc(url || 'claude.ai/code')}`,
      'Закончу — пришлю, что проверил и что меняю, и спрошу про выкладку. Если отчёта не будет час — напомню сам.',
    ].filter(Boolean).join('\n'));
  } finally {
    firing = false;
  }
}

// Заявка в работе — 'busy'; заявка, которую служба не забрала за 5 минут (tnved-deploy.path не
// работает), — 'orphan', файл снимается; брошенный файл «в работе» (службу остановили) убирается
// молча. Каталог — наш, поэтому убирать можно.
const ORPHAN_MS = 5 * 60e3;
function deploying() {
  const waiting = ops.age('deploy-request.json');
  if (waiting !== null && waiting < ORPHAN_MS) return 'busy';
  if (waiting !== null) { ops.remove('deploy-request.json'); return 'orphan'; }
  const age = ops.age('deploy-request.json.processing');
  if (age === null) return null;
  if (age < DEPLOY_STALE_MS) return 'busy';
  ops.remove('deploy-request.json.processing');
  return null;
}
const ORPHAN_TEXT = 'Служба выкладки не забрала заявку за 5 минут — проверьте на сервере: systemctl status tnved-deploy.path. Заявка снята.';

function onDeploy(chatId, cmd) {
  // «выложи» — единственные ворота: любое продолжение («не надо», условие, вопрос) их не открывает.
  if (cmd.doubt || cmd.rest) return telegram.sendTo(chatId, 'Выкладываю только по одному слову «выложи» — без вопроса и без продолжения. Что готово — «статус».');
  const s = ops.state();
  const r = s.report;
  if (running(s)) return telegram.sendTo(chatId, `⏳ Разбор ещё идёт (${esc(ago(s.fire.at))}) — отчёта пока нет. Придёт «Разбор готов» — тогда «выложи».`);
  if (!r) return telegram.sendTo(chatId, 'Выкладывать нечего: готового разбора нет. Начать — «разобрать».');
  if (r.status === 'no-change') return telegram.sendTo(chatId, 'Выкладывать нечего: последний разбор ничего не менял.');
  if (r.status !== 'changed') return telegram.sendTo(chatId, 'Выкладывать нечего: последний разбор не удался. Повторить — «разобрать заново».');
  const done = ops.readJson('deploy-result.json');
  const sameCommit = !!(done && done.commit === r.commit);
  if (sameCommit && done.ok) return telegram.sendTo(chatId, `Уже выложено ${esc(when(done.at))}: коммит <code>${esc(r.commit.slice(0, 7))}</code>.`);
  const busy = deploying();
  if (busy === 'busy') return telegram.sendTo(chatId, '⏳ Выкладка уже идёт — сервер ответит, когда закончит.');
  if (busy === 'orphan') return telegram.sendTo(chatId, ORPHAN_TEXT);
  ops.writeJson('deploy-request.json', { branch: r.branch, commit: r.commit, at: new Date().toISOString(), chat: String(chatId) });
  return telegram.sendTo(chatId, `${sameCommit ? 'Прошлая попытка была отменена — пробую ещё раз.\n' : ''}🚀 Выкладываю ветку <code>${esc(r.branch)}</code> (коммит <code>${esc(r.commit.slice(0, 7))}</code>). Сервер проверит файлы, прогонит тесты и ответит — обычно за несколько минут.`);
}

function onStatus(chatId) {
  const s = ops.state();
  const r = s.report;
  const d = ops.readJson('deploy-result.json');
  const state = deploying();
  const busy = state === 'busy';
  const watch = (ops.lastWatchReport().match(/^Дозор источников (\d\d\.\d\d\.\d{4})/) || [])[1];
  const word = { changed: 'есть правки', 'no-change': 'менять нечего', failed: 'не удался' };
  const lines = ['<b>Разбор находок</b>'];
  if (!s.fire) lines.push('Разбор: не запускался');
  else if (running(s)) lines.push(`Разбор: идёт ${esc(ago(s.fire.at))} (запущен ${esc(when(s.fire.at))})${s.fire.url ? ' — ' + esc(s.fire.url) : ''}`);
  else if (!reported(s)) lines.push(`Разбор: запущен ${esc(when(s.fire.at))}, отчёта нет — похоже, не закончил${s.fire.url ? ': ' + esc(s.fire.url) : ''}`);
  else lines.push(`Разбор: запущен ${esc(when(s.fire.at))}, закончен`);
  lines.push(`Отчёт: ${r ? `${esc(when(r.at))} — ${word[r.status] || esc(r.status)}${r.branch ? `, ветка <code>${esc(r.branch)}</code>` : ''}` : 'нет'}`);
  if (busy) lines.push('Выкладка: идёт');
  else if (state === 'orphan') lines.push('Выкладка: ' + ORPHAN_TEXT);
  else if (d) lines.push(`Выкладка: ${esc(when(d.at))} — ${d.ok ? 'выложено' : 'отменена'}${d.commit ? ' <code>' + esc(String(d.commit).slice(0, 7)) + '</code>' : ''}${!d.ok && d.error ? ' (' + esc(String(d.error).split('\n')[0].slice(0, 200)) + ')' : ''}`);
  else lines.push('Выкладка: не было');
  lines.push(`Отчёт дозора на сервере: ${watch ? 'от ' + esc(watch) : 'нет'}`);
  if (!ops.routineEnabled()) lines.push('Рутина на сервере не настроена.');
  let next = watch ? '«разобрать» — когда будет что разбирать' : 'ждать сводку дозора';
  if (busy) next = 'дождитесь ответа сервера о выкладке';
  else if (running(s)) next = 'дождитесь отчёта';
  else if (s.fire && !reported(s)) next = '«разобрать заново»';
  else if (r && r.status === 'changed' && !(d && d.ok && d.commit === r.commit)) next = '«выложи» — или «разобрать заново» и что поправить';
  lines.push('', 'Что дальше: ' + next);
  return telegram.sendTo(chatId, lines.join('\n'));
}

router.post('/telegram', async (req, res) => {
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(503).json({ error: 'not configured' });
  if (!same(req.get('x-telegram-bot-api-secret-token'), process.env.TELEGRAM_WEBHOOK_SECRET)) return res.status(403).json({ error: 'forbidden' });
  // Telegram ждёт быстрый ответ и повторяет доставку при ошибке; в чат отвечаем отдельным sendMessage.
  res.json({ ok: true });
  const msg = req.body && req.body.message;
  if (!msg || !msg.chat || !telegram.chatIds().includes(String(msg.chat.id))) return;
  const text = typeof msg.text === 'string' ? msg.text : typeof msg.caption === 'string' ? msg.caption : '';
  if (!text.trim()) return;
  const chatId = String(msg.chat.id);
  const cmd = command(text);
  try {
    // Telegram доставляет отложенные сообщения после сбоя: команда десятиминутной давности не выполняется.
    if (cmd && Number.isFinite(msg.date) && Date.now() / 1000 - msg.date > 600) {
      return void await telegram.sendTo(chatId, 'Сообщение дошло с опозданием больше 10 минут — не выполняю. Повторите, если команда ещё нужна.');
    }
    // Непонятное слово в личном чате — подсказка, а не тишина; в группе бот молчит.
    if (!cmd) { if (msg.chat.type === 'private') await telegram.sendTo(chatId, 'Не понял команду.\n\n' + HELP); return; }
    if (cmd.name === 'fix') await onFix(msg, chatId, cmd);
    else if (cmd.name === 'deploy') await onDeploy(chatId, cmd);
    else if (cmd.name === 'status') await onStatus(chatId);
    else await telegram.sendTo(chatId, HELP);
  } catch (err) {
    console.error('ops: ' + (err.friendly ? err.message : err.stack || err.message));
    await telegram.sendTo(chatId, 'Не получилось: ' + (err.friendly ? esc(err.message) : 'сбой на сервере, подробности — в журнале. Попробуйте ещё раз через минуту.'));
  }
});

function reportMessage(r, stale) {
  const lines = stale ? ['ℹ️ <b>Отчёт не от текущего запуска</b> — сервер его не запускал или номер запуска не совпал; выкладки по этому отчёту не будет.', ''] : [];
  if (r.status === 'changed') {
    lines.push('🛠 <b>Разбор готов</b>', esc(r.summary), '');
    if (r.files.length) lines.push('Изменены файлы: ' + r.files.map(esc).join(', '));
    lines.push(`Посмотреть правки: https://github.com/${REPO}/compare/main...${esc(r.branch)}`, `Ветка <code>${esc(r.branch)}</code>, коммит <code>${esc(r.commit.slice(0, 7))}</code>.`);
    if (!stale) lines.push('', 'Ответьте «выложи» — сервер проверит файлы, прогонит тесты и выложит. Не так — «разобрать заново» и что поправить.');
  } else if (r.status === 'no-change') {
    lines.push('✅ <b>Разбор: менять нечего</b>', esc(r.summary));
  } else {
    lines.push('⚠️ <b>Разбор не удался</b>', esc(r.summary));
    if (!stale) lines.push('', 'Повторить — «разобрать заново».');
  }
  return lines.join('\n');
}

router.post('/report', (req, res) => {
  if (!process.env.OPS_REPORT_SECRET) return res.status(503).json({ error: 'not configured' });
  if (!same(req.get('x-ops-secret'), process.env.OPS_REPORT_SECRET)) return res.status(403).json({ error: 'forbidden' });
  if (!reportAllowed()) return res.status(429).json({ error: 'too many reports' });

  const { status, branch, commit, summary, run, files } = req.body || {};
  if (!['changed', 'no-change', 'failed'].includes(status)) return res.status(400).json({ error: 'bad status' });
  const changed = status === 'changed';
  if (changed && (typeof branch !== 'string' || !BRANCH_RE.test(branch) || BRANCH_BAD.test(branch) || typeof commit !== 'string' || !SHA_RE.test(commit))) {
    return res.status(400).json({ error: 'bad branch or commit' });
  }
  const rec = {
    status,
    branch: changed ? branch : null,
    commit: changed ? commit : null,
    summary: String(summary || '').trim().slice(0, 3000),
    files: Array.isArray(files) ? files.filter((f) => typeof f === 'string' && /^[\w./-]{1,200}$/.test(f)).slice(0, 40) : [],
    run: typeof run === 'string' && RUN_RE.test(run) ? run : null,
    at: new Date().toISOString(),
  };
  const s = ops.state();
  // Выкладывать можно только по отчёту с номером текущего запуска: номер знает лишь та сессия,
  // которую запустил сервер. Отчёт без номера, с чужим номером или от запуска не с сервера —
  // показать, но не выкладывать.
  const stale = !(rec.run && s.fire && rec.run === s.fire.run);
  // Рутина повторила отправку того же отчёта — не второе сообщение администраторам.
  const p = s.report;
  const duplicate = !!(p && p.status === rec.status && p.commit === rec.commit && p.summary === rec.summary && p.run === rec.run);
  if (!stale && !duplicate) ops.setState({ report: rec });
  if (!duplicate) telegram.notify(reportMessage(rec, stale));
  res.json({ ok: true, stale, duplicate });
});

// Не больше четырёх загрузок одновременно: сайты ведомств не должны видеть с нашего адреса шквал.
const FETCH_PARALLEL = 4;
let fetching = 0;
router.get('/fetch', async (req, res) => {
  if (!process.env.OPS_REPORT_SECRET) return res.status(503).json({ error: 'not configured' });
  if (!same(req.get('x-ops-secret'), process.env.OPS_REPORT_SECRET)) return res.status(403).json({ error: 'forbidden' });
  if (!fetchAllowed()) return res.status(429).json({ error: 'too many requests' });
  if (fetching >= FETCH_PARALLEL) return res.status(429).set('retry-after', '5').json({ error: 'busy' });
  const one = (v) => (typeof v === 'string' ? v : '');
  fetching++;
  try {
    await official.pipe(one(req.query.url), { referer: one(req.query.referer) }, res);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    const known = ['not-allowed', 'redirect', 'upstream', 'timeout', 'network'].includes(err.code);
    if (!known) console.error('ops fetch: ' + (err.stack || err.message));
    const code = err.code === 'not-allowed' ? 400 : err.code === 'timeout' ? 504 : 502;
    res.status(code).json({ error: known ? err.code : 'failed', message: known ? err.message : 'сбой на сервере', status: err.status });
  } finally {
    fetching--;
  }
});

// Рутина молчит дольше часа — одно напоминание администраторам. Состояние на диске, поэтому
// перезапуск API напоминания не теряет и не повторяет.
function checkSilence() {
  const s = ops.state();
  if (!s.fire || s.fire.warned || reported(s) || Date.now() - Date.parse(s.fire.at) < SILENCE_MS) return false;
  ops.setState({ fire: { ...s.fire, warned: true } });
  telegram.notify([
    '⏳ <b>Разбор молчит</b>',
    `Запущен ${esc(when(s.fire.at))}, отчёта нет уже ${esc(ago(s.fire.at))}. Рутина могла не закончить работу или не достучаться до сервера.`,
    s.fire.url ? 'Ход работы: ' + esc(s.fire.url) : null,
    'Запустить снова — «разобрать заново».',
  ].filter(Boolean).join('\n'));
  return true;
}
function init() {
  setInterval(() => { try { checkSilence(); } catch (err) { console.error('ops: ' + err.message); } }, 5 * 60e3).unref();
}

module.exports = router;
module.exports.command = command;
module.exports.init = init;
module.exports.checkSilence = checkSilence;
