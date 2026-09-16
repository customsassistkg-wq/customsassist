// Сборка server/private/ett-footnotes.json — сносок ЕЭК к кодам и ставкам ЕТТ
// для AI-помощника.
//
// Источник — страница https://eec.eaeunion.org/comission/department/catr/ett/:
//   • PDF групп ЕТТ (ru.NN_2022*.pdf) — в них пометки сносок у строк кодов;
//   • «Примечания к ЕТТ_<дата>.pdf» — тексты сносок к ставкам: «63С) Ставка … применяется …»;
//   • «Примечания к ТН ВЭД_<дата>.pdf» — тексты сносок к наименованиям: «12) При подтверждении …».
//
// В тексте PDF пометка склеена с соседним словом, и в этом вся трудность:
//   «шт 563С)»       — ставка 5, сноска 63С;
//   «– 6,567С)»      — ставка 6,5, сноска 67С;
//   «говядина12)»    — сноска 12 к наименованию.
// Ставку кода мы знаем из ETT_DB, поэтому число перед «С)» делится однозначно:
// отрезаем ставку спереди, остаток — номер сноски. Если ставка не совпала с
// началом числа, строка пропускается и попадает в отчёт — угадывать нельзя.
//
// Запуск: node tools/build-ett-footnotes.js <папка>
// В папке: txt/ru.NN_2022*.txt (текст групп), ett_fn.txt и tnved_fn.txt (текст двух PDF сносок),
// извлечённые заранее (pypdf).
process.env.AI_API_KEY = process.env.AI_API_KEY || 'build';
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
if (!dir) throw new Error('usage: node tools/build-ett-footnotes.js <dir>');
const root = path.join(__dirname, '..');
const { checker } = require(path.join(root, 'server/src/services/assistant'));
const c = checker();
const rateOf = new Map(c.ETT_DB.map((r) => [r[0], r[3]]));

// Тексты сносок: «NС) …» до следующей «MС)», «N) …» до следующей «M)».
function parseNotes(file, re) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const out = {};
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    out[m[1]] = text.slice(m.index + m[0].length, end).replace(/\s+/g, ' ').trim().slice(0, 2000);
  });
  return out;
}
// Буква сноски в PDF бывает и кириллической «С», и латинской «C» (с 82-й сноски — латинская).
const rateNotes = parseNotes('ett_fn.txt', /(?:^|\n)\s*(\d{1,3})[СC]\)\s/g);
const nameNotes = parseNotes('tnved_fn.txt', /(?:^|\n)\s*(\d{1,2})\)\s/g);

const rateStr = (r) => String(r).replace(/\s/g, '').replace('.', ',');
const codes = {};
const skipped = [];
for (const f of fs.readdirSync(path.join(dir, 'txt')).filter((x) => /^ru\.\d\d_2022/.test(x)).sort()) {
  const text = fs.readFileSync(path.join(dir, 'txt', f), 'utf8');
  // Строка кода — от «NNNN NN NNN N» до следующего такого кода.
  const rows = [...text.matchAll(/(?:^|\n)\s*\+?\s*(\d{4} \d{2} \d{3} \d)\b/g)];
  rows.forEach((m, i) => {
    const code = m[1].replace(/ /g, '');
    const end = i + 1 < rows.length ? rows[i + 1].index : text.length;
    const row = text.slice(m.index + m[0].length, end).split(/\n\s*Код\s*\n/)[0];
    const found = { rate: [], name: [] };
    for (const mm of row.matchAll(/([\d,]*\d)[СC]\)/g)) {
      const run = mm[1];
      const r = rateOf.has(code) ? rateStr(rateOf.get(code)) : null;
      let n = null;
      if (rateNotes[run]) n = run;                                   // «кг63С)» — ставка не приклеена
      if (r && /^[\d,]+$/.test(r) && run.startsWith(r) && rateNotes[run.slice(r.length)]) n = run.slice(r.length);
      if (n && !found.rate.includes(n)) found.rate.push(n);
      else if (!n) skipped.push(`${code} «${run}С)» при ставке «${r}»`);
    }
    // Сноска к наименованию: цифры сразу после буквы или «)», затем «)» и пробел/конец строки.
    for (const mm of row.matchAll(/[A-Za-zА-Яа-яё)](\d{1,2})\)(?=\s|$)/g)) {
      if (nameNotes[mm[1]] && !found.name.includes(mm[1])) found.name.push(mm[1]);
    }
    if (found.rate.length || found.name.length) {
      const prev = codes[code] || { rate: [], name: [] };
      codes[code] = { rate: [...new Set([...prev.rate, ...found.rate])], name: [...new Set([...prev.name, ...found.name])] };
    }
  });
}

const out = {
  source: 'https://eec.eaeunion.org/comission/department/catr/ett/',
  built: new Date().toISOString().slice(0, 10),
  rateNotes, nameNotes, codes,
};
fs.writeFileSync(path.join(root, 'server/private/ett-footnotes.json'), JSON.stringify(out));
const withRate = Object.values(codes).filter((x) => x.rate.length).length;
const withName = Object.values(codes).filter((x) => x.name.length).length;
console.log('сносок к ставкам', Object.keys(rateNotes).length, 'к наименованиям', Object.keys(nameNotes).length);
console.log('кодов со сноской к ставке', withRate, 'к наименованию', withName, 'не разобрано пометок', skipped.length);
if (skipped.length) console.log(skipped.slice(0, 20).join('\n'));
