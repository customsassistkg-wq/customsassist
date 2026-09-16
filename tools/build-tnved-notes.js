// Сборка server/private/tnved-notes.json — примечаний к разделам и группам
// ТН ВЭД ЕАЭС для инструмента group_notes AI-помощника.
//
// Источник — официальные PDF по группам на
// https://eec.eaeunion.org/comission/department/catr/ett/ (ссылка на каждую
// группу берётся с этой страницы, дата в имени файла — дата публикации).
// Примечания стоят в начале каждой группы, до первой шапки таблицы «Код ТН ВЭД»:
// «РАЗДЕЛ …» с примечаниями к разделу (только в первой группе раздела), затем
// «ГРУППА NN», её название, «Примечания», «Примечания к субпозициям» и
// «Дополнительные примечания Евразийского экономического союза».
//
// Запуск: node tools/build-tnved-notes.js <папка с index.html и txt/*.txt>
// Текст из PDF извлекается заранее (pypdf, по файлу на группу: txt/ru.NN_2022*.txt).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = process.argv[2];
if (!dir) throw new Error('usage: node tools/build-tnved-notes.js <dir>');
const root = path.join(__dirname, '..');

// Разделы и названия групп — из той же базы, что и сайт.
const sb = { document: { getElementById: () => null, addEventListener() {} }, addEventListener() {}, localStorage: { getItem: () => null } };
vm.createContext(sb);
const src = fs.readFileSync(path.join(root, 'server/private/checker.js'), 'utf8');
const pick = (name) => {
  const m = src.match(new RegExp('^const ' + name + '=[\\s\\S]*?;\\r?$', 'm'));
  if (!m) throw new Error(name);
  return vm.runInContext(m[0].replace(/^const /, 'this.') , sb) && sb[name];
};
const SECTIONS = pick('TNVED_SECTIONS');

const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const urls = {};
for (const m of index.matchAll(/href="([^"]*\/ru\.(\d\d)_2022[^"]*\.pdf)"/g)) urls[m[2]] = 'https://eec.eaeunion.org' + m[1];

// Строки PDF → абзацы: новая строка остаётся только перед пунктом («1.», «(а)»,
// «1)»), заголовком примечаний и «Однако»; остальные переносы — это ширина полосы.
function tidy(lines) {
  const out = [];
  for (let l of lines) {
    l = l.replace(/\s+/g, ' ').trim();
    if (!l) continue;
    // Номер пункта — одна-две цифры: «9018);» в начале строки — это перенесённая
    // ссылка на позицию, а не пункт.
    const starts = /^(\d{1,2}\.|\(\w{1,3}\)|\d{1,2}\)|Примечани|Дополнительные примечания|Однако|Субпозиционн)/.test(l);
    if (!out.length || starts) out.push(l);
    else out[out.length - 1] += ' ' + l;
  }
  return out.join('\n');
}

const result = { source: 'https://eec.eaeunion.org/comission/department/catr/ett/', built: new Date().toISOString().slice(0, 10), sections: {}, chapters: {} };
for (const f of fs.readdirSync(path.join(dir, 'txt')).filter((x) => /^ru\.\d\d_2022/.test(x)).sort()) {
  const nn = f.slice(3, 5);
  const text = fs.readFileSync(path.join(dir, 'txt', f), 'utf8');
  const head = text.split(/\r?\n\s*Код\s*\r?\n\s*ТН ВЭД/)[0];
  const lines = head.split(/\r?\n/);
  const gi = lines.findIndex((l) => new RegExp('^\\s*ГРУППА\\s+' + nn + '\\b').test(l));
  if (gi < 0) throw new Error('нет строки ГРУППА ' + nn + ' в ' + f);
  const sec = SECTIONS.find((s) => +nn >= s.from && +nn <= s.to);
  if (!sec) throw new Error('раздел для группы ' + nn);

  const secLines = lines.slice(0, gi);
  const si = secLines.findIndex((l) => /^\s*РАЗДЕЛ\s+[IVXL]+/.test(l));
  if (si >= 0) {
    const body = secLines.slice(si + 1);
    const ni = body.findIndex((l) => /^\s*Примечани/.test(l));
    result.sections[sec.r] = {
      title: tidy(ni < 0 ? body : body.slice(0, ni)).replace(/\n/g, ' '),
      notes: ni < 0 ? '' : tidy(body.slice(ni)),
    };
  }

  const body = lines.slice(gi + 1);
  const ni = body.findIndex((l) => /^\s*(Примечани|Дополнительные примечания)/.test(l));
  result.chapters[nn] = {
    section: sec.r,
    title: tidy(ni < 0 ? body : body.slice(0, ni)).replace(/\n/g, ' '),
    notes: ni < 0 ? '' : tidy(body.slice(ni)),
    url: urls[nn] || result.source,
  };
}
for (const s of SECTIONS) if (!result.sections[s.r]) result.sections[s.r] = { title: s.title, notes: '' };

const n = Object.keys(result.chapters).length;
if (n !== 96) throw new Error('ожидалось 96 групп, получено ' + n);
fs.writeFileSync(path.join(root, 'server/private/tnved-notes.json'), JSON.stringify(result, null, 1));
console.log('групп', n, 'разделов с примечаниями', Object.values(result.sections).filter((s) => s.notes).length,
  'байт', fs.statSync(path.join(root, 'server/private/tnved-notes.json')).size);
