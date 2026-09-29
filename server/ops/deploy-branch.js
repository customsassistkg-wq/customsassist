#!/usr/bin/env node
// Выкладка ветки, подготовленной рутиной Claude Code, по команде «выложи» из Telegram (29.09.2026).
//
// Работает от root под tnved-deploy.service; её запускает tnved-deploy.path, когда API
// (routes/ops.js, пользователь tnved) кладёт заявку server/var/deploy-request.json. Установлена
// копией в /usr/local/lib/tnved-deploy/ (root:root) и ничего не берёт из /opt/tnved — эти файлы
// пишет пользователь tnved, и root не должен исполнять то, что tnved может подменить.
//
// Выкладывает только то, что можно выкладывать без человека у терминала:
//  - ветку claude/…, которая растёт из текущего main зеркала /srv/git/tnved.git (не откатывает
//    выложенное вручную);
//  - если она меняет только DEPLOYABLE и ALLOWED (база, дозор, их тесты, документы) — страница,
//    checker.js и src/ этим путём не выкладываются никогда;
//  - после node --check и офлайн-тестов, которые идут от пользователя tnved во временной копии.
// Затем резервная копия, замена файлов, перезапуск API, проверка, при сбое — откат. main зеркала
// и GitHub сдвигаются вперёд на выложенный коммит (без --force), итог — в Telegram администраторам.
'use strict';
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
const SHA_RE = /^[0-9a-f]{40}$/;
// Что выкладывается этим путём: файл → нужен ли перезапуск API.
const DEPLOYABLE = { 'server/private/base.js': true, 'server/scripts/watch-sources.js': false };
// Что ветка может менять сверх того — живёт только в git.
const ALLOWED = (f) => Object.prototype.hasOwnProperty.call(DEPLOYABLE, f)
  || /^server\/tests\/[\w.-]+\.test\.js$/.test(f) || /^docs\/[\w.-]+\.md$/.test(f) || f === 'session.md' || f === 'CURRENT.md';
const TESTS = ['engine', 'lookup-filter', 'direction-regime', 'assistant', 'watch-sources'];

const validRequest = (r) => !!r && BRANCH_RE.test(String(r.branch)) && SHA_RE.test(String(r.commit));
function classify(files) {
  return { bad: files.filter((f) => !ALLOWED(f)), deploy: files.filter((f) => Object.prototype.hasOwnProperty.call(DEPLOYABLE, f)) };
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

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, ...opts }).trim();
const git = (...args) => run('git', ['--git-dir=' + MIRROR, ...args], {
  env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${KEY} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes` },
});
const tail = (err) => String((err && (err.stderr || err.stdout || err.message)) || err).trim().split('\n').slice(-6).join('\n').slice(0, 900);

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
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) { console.error('telegram: ' + err.message); }
  }
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function deploy(req, log) {
  const { branch, commit } = req;
  const ref = 'refs/tg/' + branch;
  git('fetch', '--no-tags', GITHUB, `+refs/heads/${branch}:${ref}`);
  if (git('rev-parse', ref) !== commit) throw new Error('ветка на GitHub уже не та, что в отчёте: пусть рутина пришлёт новый');
  const main = git('rev-parse', 'refs/heads/main');
  try { git('merge-base', '--is-ancestor', main, commit); } catch { throw new Error(`ветка растёт не из текущего main (${main.slice(0, 7)}) — на сервер тем временем выложено другое; нужен новый разбор`); }
  const files = git('diff', '--name-only', main, commit).split('\n').filter(Boolean);
  const { bad, deploy: toDeploy } = classify(files);
  if (bad.length) throw new Error('ветка меняет файлы, которые из Telegram не выкладываются: ' + bad.slice(0, 8).join(', ') + ' — только вручную');
  log(`файлы: ${files.join(', ') || 'нет'}`);

  const app = fs.statSync(path.join(APP, 'server'));
  let restarted = false;
  if (toDeploy.length) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tnved-deploy-'));
    try {
      const tar = path.join(tmp, 'src.tar');
      git('archive', '--output=' + tar, commit);
      const tree = path.join(tmp, 'tree');
      fs.mkdirSync(tree);
      run('tar', ['-xf', tar, '-C', tree]);
      run('chown', ['-R', `${app.uid}:${app.gid}`, tmp]);
      // Ссылка — после chown: иначе chown -R прошёл бы по ней в каталог приложения.
      fs.symlinkSync(path.join(APP, 'server', 'node_modules'), path.join(tree, 'server', 'node_modules'));
      for (const f of toDeploy) run(process.execPath, ['--check', path.join(tree, f)]);
      for (const t of TESTS) {
        try {
          run('runuser', ['-u', 'tnved', '--', process.execPath, `server/tests/${t}.test.js`], { cwd: tree, timeout: 600000, env: { PATH: process.env.PATH, HOME: tmp, LANG: 'C.UTF-8' } });
        } catch (err) { throw new Error(`тест ${t} не прошёл:\n${tail(err)}`); }
      }
      log(`node --check и тесты (${TESTS.join(', ')}) — прошли`);

      const backup = path.join(BACKUPS, new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15) + '_telegram');
      for (const f of toDeploy) {
        fs.mkdirSync(path.dirname(path.join(backup, f)), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(APP, f), path.join(backup, f));
      }
      const install = (from) => {
        for (const f of toDeploy) {
          const dst = path.join(APP, f);
          fs.copyFileSync(path.join(from, f), dst + '.new');
          fs.chownSync(dst + '.new', app.uid, app.gid);
          fs.renameSync(dst + '.new', dst);
        }
      };
      install(tree);
      log(`копия прежних — ${backup}`);
      if (toDeploy.some((f) => DEPLOYABLE[f])) {
        restarted = true;
        run('systemctl', ['restart', 'tnved']);
        let ok = await waitPort(3000, 20000);
        if (ok) {
          try { run('runuser', ['-u', 'tnved', '--', process.execPath, '-e', "const B=require('./src/services/base').load();if(!B.renderHtml('0101210000').html)process.exit(1)"], { cwd: path.join(APP, 'server') }); } catch { ok = false; }
        }
        if (!ok) {
          install(backup);
          run('systemctl', ['restart', 'tnved']);
          throw new Error(`после перезапуска API не поднялся или база не отвечает — возвращены прежние файлы из ${backup}`);
        }
        log('API перезапущен, база отвечает');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    log('на сервер выкладывать нечего — ветка меняет только документы и тесты');
  }

  git('update-ref', 'refs/heads/main', commit, main);
  try { git('push', GITHUB, `${commit}:refs/heads/main`); log('main на GitHub сдвинут на выложенный коммит'); } catch (err) { log('main на GitHub не сдвинут (' + tail(err).split('\n').pop() + ') — слить ветку вручную'); }
  return { files, deployed: toDeploy, restarted };
}

async function main() {
  const reqFile = path.join(STATE, 'deploy-request.json');
  const work = reqFile + '.processing';
  if (!fs.existsSync(reqFile)) return;
  fs.renameSync(reqFile, work); // иначе tnved-deploy.path запускал бы службу снова и снова
  let req = null;
  try { req = JSON.parse(fs.readFileSync(work, 'utf8')); } catch { /* разберёт validRequest */ }
  const notes = [];
  const log = (s) => { notes.push(s); console.log(s); };
  const result = { at: new Date().toISOString(), branch: req && req.branch, commit: req && req.commit, ok: false };
  try {
    if (!validRequest(req)) throw new Error('в заявке нет ветки claude/… или полного коммита');
    Object.assign(result, await deploy(req, log), { ok: true });
  } catch (err) {
    result.error = err.message;
    console.error(err.message);
  }
  const out = path.join(STATE, 'deploy-result.json');
  fs.writeFileSync(out, JSON.stringify({ ...result, notes }, null, 1));
  try { const st = fs.statSync(STATE); fs.chownSync(out, st.uid, st.gid); } catch { /* каталог нашего же пользователя */ }
  fs.rmSync(work, { force: true });
  const head = result.ok ? '✅ <b>Выложено</b>' : '⛔ <b>Выкладка отменена</b>';
  const where = result.branch ? `\nВетка <code>${esc(result.branch)}</code>, коммит <code>${esc(String(result.commit || '').slice(0, 7))}</code>` : '';
  await telegram(`${head}${where}\n${esc(notes.join('\n'))}${result.error ? '\n\n' + esc(result.error) : ''}`);
}

module.exports = { validRequest, classify, parseEnv, ALLOWED, DEPLOYABLE };
if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
