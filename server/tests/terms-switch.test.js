// node server/tests/terms-switch.test.js
// tools/terms-switch.js (02.10.2026): из terms-next.html делает terms.html в день вступления новой редакции — заголовок без
// «новая редакция с …», без noindex, строка «Редакция от …, действует с …; предыдущая редакция — от …», без блока «Что изменилось».
// Здесь — на синтетической странице во временном каталоге (настоящая terms-next.html после 03.11.2026 исчезнет, а инструмент
// понадобится для следующей редакции): результат, --check, версия правил, отказ на непонятном месте.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tool = path.join(__dirname, '../../tools/terms-switch.js');
const next = (extra = '') => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Правила использования, новая редакция с 15.12.2027 — Customs Assist KG</title>
<meta name="robots" content="noindex">
</head>
<body>
<main>
  <h1>Правила использования сервиса</h1>
  <div class="updated">Пользовательское соглашение сервиса «Customs Assist KG» (customsassist.trade). Новая редакция от 01.11.2027, вступает в силу 15.12.2027. До этой даты действует редакция от 03.11.2026 — <a href="/terms.html">customsassist.trade/terms.html</a>.</div>

  <div class="box" style="margin:0 0 28px">
    <strong>Что изменилось по сравнению с редакцией от 03.11.2026</strong>
    <ul>
      <li>Раздел 4 — цены.</li>
    </ul>
  </div>

  <h2 id="a">1. Сервис</h2>
  <p>Текст раздела.</p>
  <div class="box">
    <p>Реквизиты поставщика — это другой блок, он остаётся.</p>
  </div>${extra}
</main>
</body>
</html>
`;
const expected = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Правила использования — Customs Assist KG</title>
</head>
<body>
<main>
  <h1>Правила использования сервиса</h1>
  <div class="updated">Пользовательское соглашение сервиса «Customs Assist KG» (customsassist.trade). Редакция от 01.11.2027, действует с 15.12.2027; предыдущая редакция — от 03.11.2026.</div>

  <h2 id="a">1. Сервис</h2>
  <p>Текст раздела.</p>
  <div class="box">
    <p>Реквизиты поставщика — это другой блок, он остаётся.</p>
  </div>
</main>
</body>
</html>
`;
const run = (root, ...a) => spawnSync(process.execPath, [tool, '--root', root, ...a], { encoding: 'utf8' });
const mk = (html) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-terms-')); fs.writeFileSync(path.join(d, 'terms-next.html'), html); return d; };
const dirs = [];
const dir = (html) => { const d = mk(html); dirs.push(d); return d; };

try {
  // 1. Результат равен ожидаемому; terms.html записан; --check после записи — 0, до записи — 1.
  let d = dir(next());
  let r = run(d, '--check');
  assert.equal(r.status, 1, 'terms.html ещё нет — отличается');
  r = run(d);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(d, 'terms.html'), 'utf8'), expected);
  assert.match(r.stdout, /редакция от 01\.11\.2027, действует с 15\.12\.2027, предыдущая от 03\.11\.2026/);
  assert.equal(run(d, '--check').status, 0);
  fs.appendFileSync(path.join(d, 'terms.html'), ' ');
  assert.equal(run(d, '--check').status, 1, 'правка вручную — отличается');

  // 2. Версия правил: инструмент называет нужное значение и предупреждает, если в auth.js другое.
  fs.mkdirSync(path.join(d, 'server/src/routes'), { recursive: true });
  fs.writeFileSync(path.join(d, 'server/src/routes/auth.js'), "const TERMS_VERSION = '2026-11-03';\n");
  r = run(d);
  assert.match(r.stdout, /ВНИМАНИЕ: TERMS_VERSION должен быть '2027-12-15', сейчас '2026-11-03'/);
  fs.writeFileSync(path.join(d, 'server/src/routes/auth.js'), "const TERMS_VERSION = '2027-12-15';\n");
  assert.match(run(d).stdout, /TERMS_VERSION = '2027-12-15' — как нужно/);

  // 3. Непонятное место — отказ с кодом 2 и без записи terms.html: нет noindex, нет блока, два блока, CRLF, нет файла.
  const bad = [
    ['без noindex', next().replace('<meta name="robots" content="noindex">\n', '')],
    ['без блока «Что изменилось»', next().replace(/ {2}<div class="box" style="margin:0 0 28px">[\s\S]*?<\/div>\n\n/, '')],
    ['два блока «Что изменилось»', next().replace('<h2 id="a">', '<div class="box" style="margin:0 0 28px">\n    <strong>Что изменилось по сравнению с редакцией от 01.01.2020</strong>\n  </div>\n\n  <h2 id="a">')],
    ['заголовок без «новая редакция с»', next().replace(', новая редакция с 15.12.2027', '')],
    ['строка объявления другая', next().replace('вступает в силу', 'начнёт действовать')],
    ['вложенный div в блоке', next().replace('<li>Раздел 4 — цены.</li>', '<li>Раздел 4 — <div>цены</div>.</li>')],
    ['CRLF', next().replace(/\n/g, '\r\n')],
  ];
  for (const [why, html] of bad) {
    const e = dir(html);
    const x = run(e);
    assert.equal(x.status, 2, why + ': ' + x.stdout + x.stderr);
    assert.match(x.stderr, /terms-switch:/, why);
    assert.equal(fs.existsSync(path.join(e, 'terms.html')), false, why + ': terms.html не должен появиться');
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-terms-')); dirs.push(empty);
  r = run(empty);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /нет .*terms-next\.html/);
  console.log('PASS: terms-switch — из объявленной редакции получается terms.html (заголовок, noindex, строка с тремя датами, блок «Что изменилось»), --check, версия правил, отказ на непонятном месте без записи');
} finally {
  for (const x of dirs) fs.rmSync(x, { recursive: true, force: true });
}
