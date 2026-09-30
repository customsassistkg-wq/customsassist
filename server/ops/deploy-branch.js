#!/usr/bin/env node
// Выкладка ветки, подготовленной рутиной Claude Code, по команде «выложи» из Telegram (29.09.2026).
//
// Работает от root под tnved-deploy.service; её запускает tnved-deploy.path, когда API
// (routes/ops.js, пользователь tnved) кладёт заявку server/var/deploy-request.json. Установлена
// копией в /usr/local/lib/tnved-deploy/ (root:root) и ничего не исполняет из /opt/tnved — эти файлы
// пишет пользователь tnved, и root не должен исполнять то, что tnved может подменить.
//
// Выкладывает только то, что можно выкладывать без человека у терминала:
//  - ветку claude/…, которая растёт из текущего main зеркала /srv/git/tnved.git, когда main на
//    GitHub не ушёл вперёд зеркала, а на сервере лежит ровно то, что в main (иначе выкладка
//    затёрла бы выложенное вручную);
//  - если она только добавляет и правит обычные файлы из DEPLOYABLE и ALLOWED (база, дозор, их
//    тесты, документы) — страница, checker.js и src/ этим путём не выкладываются никогда, а
//    удаление, переименование, ссылка и исполняемый файл — отказ;
//  - после node --check и офлайн-тестов, которые идут от пользователя tnved во временной копии.
// Затем резервная копия, замена файлов, перезапуск API, проверка, при сбое — откат с проверкой.
// Файлы на сервер берутся из git, а не из копии, где шли тесты: её мог изменить сам тест. main
// зеркала и GitHub сдвигаются вперёд на выложенный коммит (без --force), итог — в Telegram.
//
// Каталог заявок server/var принадлежит tnved, поэтому всё, что root в нём читает и пишет,
// проверяется: заявка — обычный файл, итог пишется во временный файл и переименованием.
'use strict';
// IPv6 на сервере прописан, но не работает (src/index.js): без этой строки сообщение в Telegram
// сначала ждёт таймаута по AAAA и через раз не уходит.
require('node:dns').setDefaultResultOrder('ipv4first');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const APP = process.env.TNVED_APP || '/opt/tnved';
const STATE = process.env.OPS_STATE_DIR || path.join(APP, 'server', 'var');
const MIRROR = process.env.TNVED_MIRROR || '/srv/git/tnved.git';
const GITHUB = process.env.TNVED_GITHUB || 'git@github.com:customsassistkg-wq/customsassist.git';
const KEY = process.env.TNVED_DEPLOY_KEY || '/root/.ssh/deploy_customsassist';
const BACKUPS = process.env.TNVED_BACKUPS || '/root/deploy_backups';

const BRANCH_RE = /^claude\/[A-Za-z0-9._/-]{1,100}$/;
// То, что git не примет именем ветки или прочтёт иначе: «..», «//», «@{», хвосты «/», «.», «.lock».
const BRANCH_BAD = /\.\.|\/\/|@\{|\/\.|[/.]$|\.lock$|\.lock\//;
const SHA_RE = /^[0-9a-f]{40}$/;
// Что выкладывается этим путём: файл → нужен ли перезапуск API.
const DEPLOYABLE = { 'server/private/base.js': true, 'server/scripts/watch-sources.js': false };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Что ветка может менять сверх того — живёт только в git.
const ALLOWED = (f) => own(DEPLOYABLE, f)
  || /^server\/tests\/[\w.-]+\.test\.js$/.test(f) || /^docs\/[\w.-]+\.md$/.test(f) || f === 'session.md' || f === 'CURRENT.md';
const TESTS = ['engine', 'lookup-filter', 'direction-regime', 'assistant', 'watch-sources'];
// Пять тестов по четыре минуты, затем замена, перезапуск и возможный откат — всё должно
// уложиться в TimeoutStartSec службы (30 минут); после INSTALL_DEADLINE_MS замена не начинается.
const TEST_TIMEOUT_MS = 240000;
const INSTALL_DEADLINE_MS = 18 * 60e3;
const MAX_FILE = 256 * 1024 * 1024;

const validBranch = (b) => typeof b === 'string' && BRANCH_RE.test(b) && !BRANCH_BAD.test(b);
const validRequest = (r) => !!r && validBranch(r.branch) && SHA_RE.test(String(r.commit));
function classify(files) {
  return { bad: files.filter((f) => !ALLOWED(f)), deploy: files.filter((f) => own(DEPLOYABLE, f)) };
}
// Вывод git diff --raw --no-renames -z: «:режим режим хэш хэш БУКВА\0путь\0».
function parseRaw(raw) {
  const parts = String(raw).split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = parts[i].match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/);
    out.push(m ? { path: parts[i + 1], status: m[3], oldMode: m[1], mode: m[2] } : { path: parts[i + 1] || parts[i], status: '?', oldMode: '', mode: '' });
  }
  return out;
}
// Почему изменение не принимается; пустой список — можно выкладывать.
function refuse(changes) {
  const bad = [];
  for (const c of changes) {
    if (!ALLOWED(c.path)) bad.push(`${c.path} — этот файл из Telegram не выкладывается`);
    else if (c.status === 'D') bad.push(`${c.path} — файл удалён`);
    else if (c.status !== 'A' && c.status !== 'M') bad.push(`${c.path} — изменение вида «${c.status}»`);
    else if (c.mode !== '100644') bad.push(`${c.path} — не обычный файл (режим ${c.mode})`);
  }
  return bad;
}
// .env без зависимостей: КЛЮЧ=значение, кавычки по краям снимаются.
function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gitEnv = () => ({ ...process.env, GIT_SSH_COMMAND: `ssh -i ${KEY} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20` });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, ...opts }).trim();
const git = (...args) => run('git', ['--git-dir=' + MIRROR, ...args], { env: gitEnv() });
// Без trim и без предела в мегабайт: «сырой» список изменений и содержимое файлов (база — 12 МБ).
const gitRaw = (...args) => execFileSync('git', ['--git-dir=' + MIRROR, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: MAX_FILE, env: gitEnv() });
const gitBuf = (...args) => execFileSync('git', ['--git-dir=' + MIRROR, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: MAX_FILE, env: gitEnv() });
const isAncestor = (a, b) => { try { git('merge-base', '--is-ancestor', a, b); return true; } catch { return false; } };
const tail = (err) => String((err && (err.stderr || err.stdout || err.message)) || err).trim().split('\n').slice(-6).join('\n').slice(0, 900);
const lastLine = (err) => tail(err).split('\n').pop();

function waitPort(port, ms) {
  const until = Date.now() + ms;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); if (Date.now() > until) resolve(false); else setTimeout(tryOnce, 500); });
    };
    tryOnce();
  });
}

async function telegram(html) {
  let env = {};
  try { env = parseEnv(fs.readFileSync(path.join(APP, 'server', '.env'), 'utf8')); } catch { /* без .env — молча */ }
  const ids = String(env.TELEGRAM_ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^-?\d{1,20}$/.test(s));
  if (!env.TELEGRAM_BOT_TOKEN || !ids.length) return;
  for (const id of ids) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
      // Токен стоит в адресе запроса — в журнал только код и текст ошибки Telegram.
      if (!res.ok) console.error(`telegram: HTTP ${res.status} ${String((await res.json().catch(() => ({}))).description || '').slice(0, 200)}`);
    } catch (err) { console.error('telegram: ' + (err.name === 'TimeoutError' ? 'timeout' : err.name)); }
  }
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Файл встаёт на место переименованием из каталога root: в каталоге приложения, который пишет
// tnved, root не создаёт и не правит ничего по имени, которое tnved мог бы подменить ссылкой.
function place(stageDir, f, buf, owner) {
  const dst = path.join(APP, f);
  const tmp = path.join(stageDir, crypto.randomBytes(6).toString('hex') + '-' + path.basename(f));
  fs.writeFileSync(tmp, buf, { mode: 0o644, flag: 'wx' });
  fs.chownSync(tmp, owner.uid, owner.gid);
  try {
    fs.renameSync(tmp, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Другой раздел диска: переименовать нельзя — пишем рядом, не следуя по ссылкам.
    const near = dst + '.new';
    fs.rmSync(near, { force: true });
    fs.writeFileSync(near, buf, { mode: 0o644, flag: 'wx' });
    fs.lchownSync(near, owner.uid, owner.gid);
    fs.renameSync(near, dst);
    fs.rmSync(tmp, { force: true });
  }
}

async function restartAndCheck() {
  try { run('systemctl', ['restart', 'tnved']); } catch { return false; }
  if (!(await waitPort(3000, 30000))) return false;
  try {
    run('runuser', ['-u', 'tnved', '--', process.execPath, '-e', "const B=require('./src/services/base').load();if(!B.renderHtml('0101210000').html)process.exit(1)"], { cwd: path.join(APP, 'server'), timeout: 120000 });
    return true;
  } catch { return false; }
}

async function deploy(req, log, progress) {
  const { branch, commit } = req;
  const ref = 'refs/tg/' + branch;
  try {
    return await deployBranch(req, ref, log, progress);
  } finally {
    // Ссылка на ветку в зеркале нужна только на время выкладки: иначе объекты отклонённых веток
    // копились бы навсегда, а ветка с именем «внутри» прежней не забиралась бы.
    try { git('update-ref', '-d', ref); } catch { /* её могло и не быть */ }
  }
}

async function deployBranch(req, ref, log, progress) {
  const { branch, commit } = req;
  const started = Date.now();
  try {
    git('fetch', '--no-tags', GITHUB, `+refs/heads/${branch}:${ref}`, '+refs/heads/main:refs/tg/github-main');
  } catch (err) { throw new Error('не удалось получить ветку с GitHub: ' + lastLine(err)); }
  if (git('rev-parse', ref) !== commit) throw new Error('ветка на GitHub уже не та, что в отчёте: нужен новый разбор');
  const main = git('rev-parse', 'refs/heads/main');
  const hub = git('rev-parse', 'refs/tg/github-main');
  const short = (h) => h.slice(0, 7);
  if (hub !== main) {
    // Ветка растёт из main GitHub — после выравнивания зеркал нужен не новый разбор, а снова «выложи».
    if (isAncestor(main, hub)) throw new Error(`main на GitHub (${short(hub)}) новее, чем в зеркале сервера (${short(main)}): туда отправлены коммиты, которых на сервере нет. Отправьте main в зеркало (git push vps main), затем ${isAncestor(hub, commit) ? 'снова «выложи»' : '«разобрать заново»'}.`);
    if (!isAncestor(hub, main)) throw new Error(`main на GitHub (${short(hub)}) и в зеркале сервера (${short(main)}) разошлись — нужна ручная сверка`);
    // GitHub отстаёт от зеркала (прошлая выкладка не смогла его сдвинуть, или main отправлен только
    // в зеркало): рутина берёт main с GitHub, и каждая её ветка будет расти из устаревшего main.
    if (!isAncestor(main, commit)) throw new Error(`main на GitHub (${short(hub)}) отстаёт от зеркала сервера (${short(main)}), и ветка растёт из устаревшего main. Отправьте main на GitHub (git push origin main), затем «разобрать заново».`);
  }
  if (commit === main) throw new Error('эта ветка уже в main — выкладывать нечего');
  if (!isAncestor(main, commit)) throw new Error(`ветка растёт не из текущего main (${short(main)}) — на сервер тем временем выложено другое; нужен новый разбор («разобрать заново»)`);
  const changes = parseRaw(gitRaw('diff', '--raw', '--no-renames', '--no-abbrev', '--ignore-submodules=none', '-z', main, commit));
  const bad = refuse(changes);
  if (bad.length) throw new Error('ветка меняет то, что из Telegram не выкладывается:\n' + bad.slice(0, 8).join('\n') + (bad.length > 8 ? `\n… и ещё ${bad.length - 8}` : '') + '\nТакая правка выкладывается только вручную.');
  const files = changes.map((c) => c.path);
  const toDeploy = files.filter((f) => own(DEPLOYABLE, f));
  log(`файлы: ${files.join(', ') || 'нет'}`);

  // На сервере должно лежать то же, что в main: иначе выкладка молча затёрла бы правку,
  // выложенную вручную и не отправленную в зеркало, или выложила бы то, что ждало своей очереди.
  // Читается без следования по ссылкам, сверяется дважды: здесь и перед самой заменой.
  const inMain = {};
  const liveEquals = (f) => {
    const fd = fs.openSync(path.join(APP, f), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) return false;
      return sha256(fs.readFileSync(fd)) === sha256(inMain[f]);
    } finally { fs.closeSync(fd); }
  };
  for (const f of toDeploy) {
    inMain[f] = gitBuf('cat-file', 'blob', `${main}:${f}`);
    let same = false;
    try { same = liveEquals(f); } catch { /* ссылка или нет файла — тоже «не то» */ }
    if (!same) throw new Error(`на сервере ${f} отличается от main (${short(main)}): выложено вручную и не отправлено в зеркало, или отправлено и не выложено. Нужно привести сервер и main к одному (выкладка и git push vps main), затем «разобрать заново».`);
  }

  const app = fs.statSync(path.join(APP, 'server'));
  let restarted = false;
  if (toDeploy.length) {
    const fresh = {};
    for (const f of toDeploy) fresh[f] = gitBuf('cat-file', 'blob', `${commit}:${f}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tnved-deploy-'));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    const backup = path.join(BACKUPS, stamp + '_telegram');
    const stage = path.join(BACKUPS, '.stage-' + stamp + '-' + process.pid);
    try {
      const tar = path.join(tmp, 'src.tar');
      git('archive', '--output=' + tar, commit);
      const tree = path.join(tmp, 'tree');
      fs.mkdirSync(tree);
      run('tar', ['-xf', tar, '-C', tree]);
      // Ссылка — до передачи каталога tnved: root ничего не создаёт по имени в чужом каталоге;
      // chown -R по ссылкам не ходит.
      fs.symlinkSync(path.join(APP, 'server', 'node_modules'), path.join(tree, 'server', 'node_modules'));
      run('chown', ['-R', `${app.uid}:${app.gid}`, tmp]);
      fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
      for (const f of toDeploy) {
        const probe = path.join(stage, 'check-' + path.basename(f));
        fs.writeFileSync(probe, fresh[f], { flag: 'wx' });
        try { run(process.execPath, ['--check', probe]); } catch (err) { throw new Error(`${f}: ошибка синтаксиса\n${tail(err)}`); }
        fs.rmSync(probe, { force: true });
      }
      for (const t of TESTS) {
        try {
          run('runuser', ['-u', 'tnved', '--', process.execPath, `server/tests/${t}.test.js`], { cwd: tree, timeout: TEST_TIMEOUT_MS, env: { PATH: process.env.PATH, HOME: tmp, LANG: 'C.UTF-8' } });
        } catch (err) { throw new Error(err.code === 'ETIMEDOUT' ? `тест ${t} не уложился в ${TEST_TIMEOUT_MS / 60000} минуты` : `тест ${t} не прошёл:\n${tail(err)}`); }
      }
      log(`node --check и тесты (${TESTS.join(', ')}) — прошли`);
      // Дальше — замена, перезапуск и, если что, откат: на них нужно время до TimeoutStartSec службы.
      if (Date.now() - started > INSTALL_DEADLINE_MS) throw new Error('проверки заняли слишком долго, на замену файлов и откат времени не остаётся — повторите «выложи»');

      // Копия прежних — из main, с которым сервер только что сверен ещё раз: откат вернёт ровно то,
      // что в main, а не то, что успело появиться в каталоге приложения за время тестов.
      for (const f of toDeploy) {
        if (!liveEquals(f)) throw new Error(`${f} на сервере изменился, пока шли тесты — выкладка остановлена, ничего не заменено`);
        fs.mkdirSync(path.dirname(path.join(backup, f)), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(backup, f), inMain[f], { mode: 0o600 });
      }
      log(`копия прежних — ${backup}`);
      const restart = toDeploy.some((f) => DEPLOYABLE[f]);
      progress.installed = true;
      try {
        for (const f of toDeploy) place(stage, f, fresh[f], app);
        if (restart && !(await restartAndCheck())) throw new Error('после перезапуска API не поднялся или база не отвечает');
        // main зеркала — здесь, пока откат ещё возможен: сервер и main остаются равны.
        try { git('update-ref', 'refs/heads/main', commit, main); } catch (err) { throw new Error('main зеркала сдвинулся за время выкладки (' + lastLine(err) + ')'); }
      } catch (err) {
        // Откат — при любой ошибке после первой замены: на сервере не остаётся половины выкладки.
        let back = false;
        try {
          for (const f of toDeploy) place(stage, f, inMain[f], app);
          back = restart ? await restartAndCheck() : true;
        } catch (err2) { console.error('откат: ' + err2.message); }
        progress.installed = !back;
        progress.rolledBack = back;
        throw new Error(`${err.message} — ` + (back
          ? `возвращены прежние файлы (копия в ${backup}), сайт работает на прежней базе.`
          : `ОТКАТ НЕ УДАЛСЯ: нужна срочная ручная проверка сервера; прежние файлы — в ${backup}.`));
      }
      restarted = restart;
      if (restart) log('API перезапущен, база отвечает');
    } finally {
      // Уборка не должна превращать сделанную выкладку в отказ.
      for (const d of [tmp, stage]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) { console.error('уборка: ' + err.message); } }
    }
  } else {
    log('на сервер выкладывать нечего — ветка меняет только документы и тесты');
    try { git('update-ref', 'refs/heads/main', commit, main); } catch (err) { throw new Error('main зеркала сдвинулся за время проверки (' + lastLine(err) + ') — повторите «выложи»'); }
  }

  try {
    git('push', GITHUB, `${commit}:refs/heads/main`);
    log('main на GitHub сдвинут на выложенный коммит');
  } catch (err) { log('main на GitHub не сдвинут (' + lastLine(err) + ') — отправьте main на GitHub вручную (git push origin main), иначе следующий разбор вырастет из устаревшего main'); }
  return { files, deployed: toDeploy, restarted };
}

// Итог — во временный файл и переименованием: по имени deploy-result.json в каталоге tnved
// root не пишет (на его месте могла бы оказаться ссылка).
function writeResult(value) {
  const out = path.join(STATE, 'deploy-result.json');
  const tmp = `${out}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o644, flag: 'wx' });
  try { const st = fs.statSync(STATE); fs.lchownSync(tmp, st.uid, st.gid); } catch { /* каталог нашего же пользователя */ }
  fs.renameSync(tmp, out);
}

function message(result, notes, progress) {
  const lines = [result.ok ? '✅ <b>Выложено</b>' : '⛔ <b>Выкладка отменена</b>'];
  if (result.branch) lines.push(`Ветка <code>${esc(result.branch)}</code>, коммит <code>${esc(String(result.commit || '').slice(0, 7))}</code>`);
  for (const n of notes) lines.push(esc(n));
  if (result.error) lines.push('', ...esc(result.error).split('\n'));
  if (!result.ok && !progress.installed && !progress.rolledBack) lines.push('', 'На сайте ничего не изменилось.');
  if (result.ok && result.restarted) lines.push('', 'Сайт работает на обновлённой базе.');
  // Строк немного и они короткие (список отказов — не больше восьми): до предела Telegram далеко.
  return lines.join('\n').slice(0, 4000);
}

async function main() {
  const reqFile = path.join(STATE, 'deploy-request.json');
  const work = reqFile + '.processing';
  if (!fs.existsSync(reqFile)) return;
  if (fs.lstatSync(STATE).isSymbolicLink()) throw new Error('каталог заявок — ссылка: ' + STATE);
  fs.renameSync(reqFile, work); // иначе tnved-deploy.path запускал бы службу снова и снова
  let req = null;
  try {
    if (fs.lstatSync(work).isFile()) req = JSON.parse(fs.readFileSync(work, 'utf8'));
  } catch { /* разберёт validRequest */ }
  const notes = [];
  const log = (s) => { notes.push(s); console.log(s); };
  const progress = { installed: false, rolledBack: false };
  const result = { at: new Date().toISOString(), branch: req && validBranch(req.branch) ? req.branch : null, commit: req && SHA_RE.test(String(req.commit)) ? req.commit : null, ok: false };
  try {
    if (!validRequest(req)) throw new Error('в заявке нет ветки claude/… или полного коммита');
    Object.assign(result, await deploy(req, log, progress), { ok: true });
  } catch (err) {
    // Свои сообщения — по-русски; неожиданная ошибка (диск, права, git) получает русскую первую строку.
    result.error = /[а-яё]/i.test(err.message) ? err.message : 'сбой на сервере при выкладке:\n' + tail(err);
    console.error(err.stack || err.message);
  }
  // ponytail: остановку службы по времени (SIGTERM) не ловлю — тесты ограничены так, что она
  // не наступает; брошенную заявку старше 35 минут убирает API (routes/ops.js, deploying).
  try { writeResult({ ...result, notes }); } catch (err) { console.error('итог не записан: ' + err.message); }
  fs.rmSync(work, { force: true });
  await telegram(message(result, notes, progress));
}

module.exports = { validRequest, validBranch, classify, parseRaw, refuse, parseEnv, message, ALLOWED, DEPLOYABLE };
if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
