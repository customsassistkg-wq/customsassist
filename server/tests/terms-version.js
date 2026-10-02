// Версия правил, на которой стоят пользователи в тестах (02.10.2026). Читается из routes/auth.js, а не пишется в каждом тесте:
// вступление новой редакции правил меняет TERMS_VERSION (docs/launch.md, «Вступление новой редакции»), и двенадцать тестов с
// зашитой «2026-09-18» разом показывали бы всем вошедшим окно «Принимаю» и падали. Файл читается как текст, routes/auth.js
// не загружается: тесты сначала подменяют базу, и загрузка раньше времени сломала бы подмену.
const fs = require('node:fs');
const path = require('node:path');

const m = /const TERMS_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf8'));
if (!m) throw new Error('TERMS_VERSION не найден в routes/auth.js');
module.exports = m[1];
