// Разбор находок дозора из Telegram (29.09.2026): состояние на диске, в server/var, а не в базе —
// служба выкладки (server/ops/deploy-branch.js) работает от root и не должна зависеть ни от
// PostgreSQL, ни от кода приложения.
//
// Файлы каталога (OPS_STATE_DIR, по умолчанию server/var):
//   watch-last.txt       — полный отчёт последнего дозора с находками (scripts/watch-sources.js --mail)
//   ops-state.json       — последний запуск рутины и её последний отчёт (routes/ops.js)
//   deploy-request.json  — заявка «выложи»; появление файла запускает tnved-deploy.path
//   deploy-result.json   — чем кончилась последняя выкладка (пишет служба выкладки)
const fs = require('node:fs');
const path = require('node:path');

const dir = () => process.env.OPS_STATE_DIR || path.join(__dirname, '..', '..', 'var');
const file = (name) => path.join(dir(), name);

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return null;
  }
}

// Запись через переименование: служба выкладки не увидит полузаписанную заявку.
function writeJson(name, value) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file(name));
}

const exists = (name) => fs.existsSync(file(name));
const state = () => readJson('ops-state.json') || {};
function setState(patch) {
  const next = { ...state(), ...patch };
  writeJson('ops-state.json', next);
  return next;
}

function saveWatchReport(text) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file('watch-last.txt'), String(text));
}
function lastWatchReport() {
  try {
    return fs.readFileSync(file('watch-last.txt'), 'utf8');
  } catch {
    return '';
  }
}

// Рутина Claude Code с API-триггером: адрес …/routines/<id>/fire и её токен — в .env.
const routineEnabled = () => /^https:\/\/api\.anthropic\.com\//.test(process.env.ROUTINE_FIRE_URL || '') && !!process.env.ROUTINE_TOKEN;

module.exports = { dir, readJson, writeJson, exists, state, setState, saveWatchReport, lastWatchReport, routineEnabled };
