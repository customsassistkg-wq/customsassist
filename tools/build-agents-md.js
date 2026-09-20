// Пересобирает AGENTS.md из CLAUDE.md: тот же текст, две строки заголовка для Codex.
// Запуск: node tools/build-agents-md.js  (из корня репозитория, в том же коммите, что правка CLAUDE.md).
// Проверка: diff AGENTS.md CLAUDE.md должен показывать ровно эти две строки.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
const lines = src.split('\n');
if (lines[0].replace(/\r$/, '') !== '# CLAUDE.md') throw new Error('CLAUDE.md must start with "# CLAUDE.md"');
lines[0] = lines[0].replace('# CLAUDE.md', '# AGENTS.md');
const i = lines.findIndex((l) => l.startsWith('This file provides guidance to Claude Code (claude.ai/code)'));
if (i < 0) throw new Error('intro line "This file provides guidance to Claude Code (claude.ai/code)" not found');
lines[i] = lines[i].replace('Claude Code (claude.ai/code)', 'Codex (Codex.ai/code)');
fs.writeFileSync(path.join(root, 'AGENTS.md'), lines.join('\n'));
console.log('AGENTS.md rebuilt from CLAUDE.md');
