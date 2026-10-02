// node tools/terms-switch.js [--root <каталог>] [--check]
// Из terms-next.html (новая редакция правил, объявленная на сайте за месяц) делает terms.html — как нужно в день вступления
// (docs/launch.md, «Вступление новой редакции — по шагам»), одной воспроизводимой командой вместо ручной правки ночью:
//   • заголовок без «, новая редакция с ДД.ММ.ГГГГ»;
//   • без <meta name="robots" content="noindex"> (страница объявления скрыта от поисковиков, действующие правила — нет);
//   • строка .updated: «Редакция от <дата редакции>, действует с <дата вступления>; предыдущая редакция — от <дата прежней>.» —
//     все три даты читаются из строки объявления «Новая редакция от …, вступает в силу …. До этой даты действует редакция от …»;
//   • без блока «Что изменилось по сравнению с редакцией от …».
// Печатает дату вступления в виде ГГГГ-ММ-ДД — это новое значение TERMS_VERSION в server/src/routes/auth.js, и предупреждает,
// если там другое. С --check ничего не пишет, только проверяет, что terms.html уже равен результату (код выхода 1, если нет).
// Любое непонятное место — ошибка, а не молчаливая правка: нужная конструкция не найдена или найдена дважды — выход с кодом 2.
// Использовано 02.10.2026 для заготовки ветки claude/terms-2026-11-03 (результат совпал с ручной правкой байт в байт).
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const root = path.resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : path.join(__dirname, '..'));
const checkOnly = args.includes('--check');

function fail(msg) { console.error('terms-switch: ' + msg); process.exit(2); }
const once = (s, re, what) => {
  const m = [...s.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  if (m.length !== 1) fail(`${what}: найдено ${m.length}, ожидалось одно`);
  return m[0];
};

function convert(html) {
  if (html.includes('\r')) fail('в terms-next.html окончания CRLF — приведите к LF');
  let t = html;
  // 1. заголовок
  const title = once(t, /<title>([^<]*?), новая редакция с (\d\d\.\d\d\.\d{4})([^<]*)<\/title>/, 'заголовок с «новая редакция с …»');
  t = t.replace(title[0], `<title>${title[1]}${title[3]}</title>`);
  // 2. noindex
  const robots = once(t, /<meta name="robots" content="noindex">\n/, 'meta noindex');
  t = t.replace(robots[0], '');
  // 3. строка .updated
  const upd = once(t, /<div class="updated">([^<]*?)Новая редакция от (\d\d\.\d\d\.\d{4}), вступает в силу (\d\d\.\d\d\.\d{4})\. До этой даты действует редакция от (\d\d\.\d\d\.\d{4})[^<]*(?:<a [^>]*>[^<]*<\/a>)?[^<]*<\/div>/, 'строка .updated объявления');
  const [, lead, edition, effective, previous] = upd;
  t = t.replace(upd[0], `<div class="updated">${lead}Редакция от ${edition}, действует с ${effective}; предыдущая редакция — от ${previous}.</div>`);
  // 4. блок «Что изменилось …»: <div class="box" …><strong>Что изменилось …</strong> … </div> без вложенных div
  const box = once(t, /[ \t]*<div class="box"[^>]*>\n[ \t]*<strong>Что изменилось по сравнению с редакцией от [^<]*<\/strong>[\s\S]*?<\/div>\n\n?/, 'блок «Что изменилось»');
  if ((box[0].match(/<div/g) || []).length !== 1) fail('в блоке «Что изменилось» есть вложенные div — разберите вручную');
  t = t.replace(box[0], '');
  const iso = effective.split('.').reverse().join('-');
  return { html: t, effective, iso, edition, previous };
}

const next = path.join(root, 'terms-next.html');
const cur = path.join(root, 'terms.html');
if (!fs.existsSync(next)) fail('нет ' + next + ' — объявленной редакции нет или она уже вступила в силу');
const r = convert(fs.readFileSync(next, 'utf8'));
if (checkOnly) {
  const same = fs.existsSync(cur) && fs.readFileSync(cur, 'utf8') === r.html;
  console.log(same ? 'terms.html уже равен результату' : 'terms.html отличается от результата');
  process.exitCode = same ? 0 : 1;
} else {
  fs.writeFileSync(cur, r.html);
  console.log(`terms.html записан: редакция от ${r.edition}, действует с ${r.effective}, предыдущая от ${r.previous}`);
}
const auth = path.join(root, 'server/src/routes/auth.js');
if (fs.existsSync(auth)) {
  const m = /const TERMS_VERSION = '([^']+)'/.exec(fs.readFileSync(auth, 'utf8'));
  console.log(m && m[1] === r.iso ? `TERMS_VERSION = '${r.iso}' — как нужно` : `ВНИМАНИЕ: TERMS_VERSION должен быть '${r.iso}', сейчас ${m ? "'" + m[1] + "'" : 'не найден'}`);
}
