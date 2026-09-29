// node server/tests/watch-sources.test.js
// Дозор источников (scripts/watch-sources.js) без сети: разбор таблицы gov.kg, карточки
// акта, ответа реестра НПА и счётчика ГТС на снимках разметки от 23.09.2026; сверка
// «№ N от ДД.ММ.ГГГГ» с базой; сроки датированных мер; текст отчёта. Если государство
// поменяет разметку, первым это увидит ночной запуск, а не пользователь — но этот тест
// держит сам разбор: изменил regex — не сломал старое.
const assert = require('node:assert/strict');
const w = require('../scripts/watch-sources');

// ── gov.kg: таблица постановлений ──
const govList = `<table class="table display table-hover stripe table-list"><tbody>
<tr>
  <td>16-09-2026</td>
  <td>614</td>
  <td>
    <a href="https://www.gov.kg/ru/npa/s/4835">
      <i class="jam jam-file"></i>
      Постановление Кабинета Министров КР № 614 от 14.09.2026 г.
    </a>
  </td>
</tr>
<tr>
  <td>05-09-2026</td>
  <td>601</td>
  <td>
    <a href="https://www.gov.kg/ru/npa/s/4833">
      Постановление КМ №601 от  05.09.2026
    </a>
  </td>
</tr>
</tbody></table>`;
const rows = w.parseGovList(govList);
assert.equal(rows.length, 2);
assert.deepEqual(rows[0], { pub: '2026-09-16', num: '614', url: 'https://www.gov.kg/ru/npa/s/4835', title: 'Постановление Кабинета Министров КР № 614 от 14.09.2026 г.', adopted: '2026-09-14' });
assert.equal(rows[1].adopted, '2026-09-05');
assert.equal(rows[1].pub, '2026-09-05');

// ── gov.kg: карточка акта — текст без меню и подвала ──
const govItem = `<html><body><nav>Главная Новости</nav>
<div class="section-content m-form section-npa"><h1>О введении временного запрета на ввоз отдельных видов
строительных материалов</h1><p>1. Установить временный запрет &laquo;на шесть месяцев&raquo;.</p>
<script>var x=1;</script></div><div class="aside-content d-flex flex-column">Подписаться</div></body></html>`;
const text = w.parseGovItem(govItem);
assert.match(text, /^О введении временного запрета/);
assert.match(text, /«на шесть месяцев»/);
assert.doesNotMatch(text, /Главная|Подписаться|var x/);
assert.ok(w.TRADE_RE.test(text));
assert.ok(!w.TRADE_RE.test('О награждении почётной грамотой'));

// ── реестр НПА: GetDocuments ──
const registry = {
  totalResultsCount: 3,
  data: [
    { documentCode: '7-58169', nameRu: 'Постановление Кабинета Министров КР от 14 сентября 2026 года № 615\r\n"О некоторых вопросах в сфере нефти и нефтепродуктов"', vid: 'Постановление', organ: 'Кабинет Министров Кыргызской Республики', dateAdopted: '2026-09-14T00:00:00', datePublication: '2026-09-15T00:00:00', lastEdition: '58961' },
    { documentCode: '52-1982', nameRu: 'Приказ Министерства просвещения КР от 14 сентября 2026 года № 1227/1', vid: 'Приказ', organ: 'Министерство просвещения', dateAdopted: '2026-09-14T00:00:00', lastEdition: '1' },
    { documentCode: '57-20016', nameRu: 'Распоряжение Председателя Кабинета Министров КР от 14 сентября 2026 года № 700-р', vid: 'Распоряжение', organ: 'Кабинет Министров Кыргызской Республики', dateAdopted: '2026-09-14T00:00:00', lastEdition: '1' },
  ],
};
const acts = w.parseRegistry(registry);
assert.equal(acts.length, 1, 'только постановления Кабмина');
assert.equal(acts[0].num, '615');
assert.equal(acts[0].adopted, '2026-09-14');
assert.equal(acts[0].pub, '2026-09-15');
assert.equal(acts[0].url, 'https://cbd.minjust.gov.kg/7-58169/edition/58961/ru');
assert.match(acts[0].title, /№ 615 "О некоторых вопросах/);
assert.equal(w.parseRegistry(JSON.stringify(registry)).length, 1, 'строка JSON тоже принимается');
const lawReg = { totalResultsCount: 3, data: [
  { documentCode: '4-1', nameRu: 'Закон КР от 25 сентября 2026 года № 150 "О внесении изменений в Налоговый кодекс Кыргызской Республики"', vid: 'Закон', organ: 'Жогорку Кенеш Кыргызской Республики', dateAdopted: '2026-09-25T00:00:00', lastEdition: '9' },
  { documentCode: '4-2', nameRu: 'Конституционный Закон КР от 25 сентября 2026 года № 151 "О референдуме"', vid: 'Конституционный Закон', organ: 'Жогорку Кенеш Кыргызской Республики', dateAdopted: '2026-09-25T00:00:00', lastEdition: '1' },
  registry.data[0],
] };
const laws = w.parseRegistry(lawReg, 'law');
assert.deepEqual(laws.map((l) => l.num), ['150', '151'], 'законы, с конституционными, без постановлений');
assert.deepEqual(laws.filter((l) => w.TRADE_RE.test(l.title) || w.BILL_RE.test(l.title)).map((l) => l.num), ['150'], 'в отчёт — только налоговый');

// ── ГТС: счётчик квоты среди других виджетов ──
const gts = `{"type":"customskg:chart","data":{"values":[{"name":"Импорт","value":10},{"name":"Экспорт","value":5}]}}
{"type":"customskg:quotas","data":{"values":[{"name":"Квоты на электромобили 2026г","value":25000},{"name":"На текущий момент использовано","value":24970},{"name":"Оставшееся количество квот","value":30}],"active":true}}`;
assert.deepEqual(w.parseGtsCounter(gts), { total: 25000, used: 24970, left: 30 });
assert.equal(w.parseGtsCounter('<html>нет счётчика</html>'), null);

// ── ЕС НСИ: несколько версий одного справочника, сверенный, несверенный, пропавший ──
const nsiList = [
  { code: '1994', updateDateTime: '2026-09-14T00:00:00.000Z', data: { TitleName: 'Единый реестр нотификаций' } },
  { code: '1994', updateDateTime: '2026-09-23T00:00:00.000Z', data: { TitleName: 'Единый реестр нотификаций' } },
  { code: '1022', updateDateTime: '2023-09-16T00:00:00.000Z', data: { TitleName: 'Перечень ТР' } },
  { code: '2008', updateDateTime: '2025-12-28T00:00:00.000Z', dateTimeFrom: '2026-01-29T00:00:00.000Z', data: { TitleName: 'Льготы' } },
  { code: '1067', updateDateTime: '2025-02-10T00:00:00.000Z', data: { TitleName: 'Перечень санитарных мер' } },
  { code: '1995', updateDateTime: '2026-09-23T00:00:00.000Z', data: { TitleName: 'СГР' } },
];
const nsiWatch = { 1994: { what: 'a', seen: '2026-09-14' }, 1022: { what: 'b', seen: '2023-09-16' }, 1067: { what: 'c', seen: null }, 2008: { what: 'e', seen: '2025-12-28' }, 2010: { what: 'd', seen: null } };
assert.deepEqual(w.nsiChanges(nsiList, nsiWatch), [
  { code: '1067', date: '2025-02-10', seen: null, title: 'Перечень санитарных мер', what: 'c' },
  { code: '1994', date: '2026-09-23', seen: '2026-09-14', title: 'Единый реестр нотификаций', what: 'a' },
  { code: '2008', date: '2026-01-29', seen: '2025-12-28', title: 'Льготы', what: 'e' },
  { code: '2010', missing: true, what: 'd' },
], 'поздняя версия побеждает; сверенный по той же дате молчит; не в NSI_WATCH — не смотрится');
assert.ok(Object.values(w.NSI_WATCH).every((x) => x.what && (x.seen === null || /^\d{4}-\d\d-\d\d$/.test(x.seen))), 'seen — ISO-дата или null');

// ── реестр мер защиты ЕЭК: пара по общему коду и сроку, страны не нужны ──
const remReg = [
  { actual: true, investigationnumber: 'AD-37', shortname: 'Литые диски', enddate: '2030-03-21T23:59:59Z', tnved: ['8708 70 500 9'], exportingcountrycode: ['JP', 'TH'] },
  { actual: true, investigationnumber: 'AD-24', shortname: 'Литые диски', enddate: '2029-11-18T23:59:59Z', tnved: ['8708 70 500 9'], exportingcountrycode: ['CN'] },
  { actual: true, investigationnumber: 'AD-29', shortname: 'Рессоры', enddate: '2031-08-24T23:59:59Z', tnved: ['7320 10'], exportingcountrycode: ['CN'] },
  { actual: false, investigationnumber: 'AD-2', shortname: 'Старая мера', enddate: '2020-01-01T23:59:59Z', tnved: ['7208'], exportingcountrycode: ['UA'] },
];
const remBase = [
  [['8708705009'], 'Япония, Таиланд', 'Литые диски', '', '', null, '2030-03-21'],
  [['7320101100'], 'КНР', 'Рессоры', '', '', null, '2031-08-24'],
  [['2933610000'], 'КНР', 'Меламин', '', '', null, '2027-05-08'],
];
const rd = w.remediesDiff(remReg, remBase);
assert.deepEqual(rd.missing.map((m) => m.id), ['AD-24'], 'тот же код, другой срок — другая мера');
assert.deepEqual(rd.stale.map((r) => r.name), ['Меламин'], 'строка базы без действующей меры; недействующие меры реестра не считаются');

// ── слепые пятна: срок в тексте без поля; квота без следующего года; приостановленная преференция ──
const gapBase = {
  BAN_DB: [
    { name: 'Лом', ex: true, exN: 'Запрет на вывоз с 04.09.2026 до 04.03.2027 · Пост. № 564' },
    { name: 'Уголь', ex: true, exN: 'Запрет на вывоз с 26.06.2026 до 26.12.2026', exUntil: '2026-12-26' },
    { name: 'Нефть', ex: true, exN: 'Бессрочный запрет' },
  ],
  QUOTA_DB: [[['0201'], 'Говядина', 2027], [['0201'], 'Говядина', 2026], [['0701'], 'Картофель (Иран)', 2026], [['0406'], 'Сыры (Сербия)', '2026-2028']],
  PREF_FTA: [{ n: 'Вьетнам', w: 'с 23.05.2026 по 23.11.2026 льгота временно не действует' }],
};
assert.deepEqual(w.dataGaps(gapBase, '2026-09-24').map((s) => s.slice(0, 20)), ['запрет вывоза: Лом —'], 'до октября квоты не проверяются');
const octGaps = w.dataGaps(gapBase, '2026-10-02');
assert.equal(octGaps.length, 2);
assert.match(octGaps[1], /Картофель \(Иран\).*на 2027/);
const uniBase = {
  BAN_DB: [
    { name: 'Уголь', ex: true, exUntil: '2026-12-26', exN: 'с 26.06.2026 по 26.12.2026 · ПКМ КР № 430 от 20.06.2026' },
    { name: 'Кузова', im: true, imUntil: '2026-11-25', imN: 'Пост. КМ КР №357 от 20.05.2026' },
    { name: 'Гипс', im: true, imUntil: '2026-10-25', imN: 'Пост. КМ КР №230 от 08.04.2026' },
  ],
  UNIMEAS_DB: [
    ['KG', '2026', '1', 'Временный запрет на вывоз', 'Уголь', '', [], [], [], [], 'с 23.06.2026 по 23.12.2026', 'Постановление … от 20.06.2026 № 430'],
    ['KG', '2026', '2', 'Временный запрет на ввоз', 'Кузова', '', [], [], [], [], 'с 25.05.2026 по 25.11.2026', 'Постановление … от 20.05.2026 № 357'],
    ['KG', '2025', '3', 'Временный запрет на вывоз', 'Прочее', '', [], [], [], [], 'с 09.07.2025 по 09.01.2026 прекращено', 'Постановление … от 21.06.2025 № 357'],
    ['KG', '2026', '4', 'Временный запрет на ввоз', 'Гипс', '', [], [], [], [], '25.04.2026 до 21.10.2026', 'Постановление … от 08.04.2026 № 230'],
  ],
  SOURCE_AUDIT: { unimeas: { m: 'у № 230 реестр пишет 21.10.2026 — ошибка реестра' } },
};
assert.deepEqual(w.dataGaps(uniBase, '2026-09-24').map((s) => s.split(':')[0]), ['Уголь'], 'совпавший срок, прекращённая мера и известная ошибка реестра молчат');

assert.deepEqual(w.datedMeasures(gapBase, '2026-11-15').map((d) => [d.label, d.date]), [['преференция ЗСТ (Вьетнам) приостановлена', '2026-11-23']]);

// ── ЕТТ: новое имя файла главы, будущая дата, примечания, изменяющее решение ──
const ettHtml = `<p>ТН ВЭД в ред. решений Коллегии&nbsp;от 11.08.2026 № 104,&nbsp;от 02.10.2026 № 130</p>
<a href="/upload/files/catr/ett/ru.01_2022.pdf">1</a>
<a href="/comission/department/catr/ett/ru.2022/ru.26_2022_24.08.2026.pdf">26</a>
<a href="/comission/department/catr/ett/ru.2022/ru.27_2022_20.10.2026.pdf">27</a>
<a href="/comission/department/catr/ett/ru.2022/%D0%9F%D1%80%D0%B8%D0%BC%D0%B5%D1%87%D0%B0%D0%BD%D0%B8%D1%8F%20%D0%BA%20%D0%95%D0%A2%D0%A2_24.08.2026.pdf">прим</a>`;
const ettNotes = { chapters: { '01': { url: 'https://x/upload/files/catr/ett/ru.01_2022.pdf' }, 26: { url: 'https://x/ru.26_2022_24.08.2026.pdf' }, 27: { url: 'https://x/ru.27_2022_11.07.2026.pdf' } } };
const ec = w.ettChanges(ettHtml, ettNotes, { notesEtt: '2026-08-24', notesTnved: '2025-05-11', lastAmend: '2026-08-11' }, '2026-10-05');
assert.equal(ec.chapters, 3);
assert.equal(ec.amendments, 2);
assert.deepEqual(ec.changes.map((s) => s.slice(0, 40)), ['глава 27: ЕЭК публикует ru.27_2022_20.10', 'в редакцию ЕТТ внесено решение № 130 от '], 'совпавшие главы и сверенные примечания молчат');
assert.match(ec.changes[0], /вступает 20\.10\.2026/);

// ── ТРОИС ГТС и законопроекты ──
const troisHtml = `{"href":"/site/x/_/attachment/inline/7648:8b80/11%20-16%20%D1%81%D0%B5%D0%BD%D1%82%D1%8F%D0%B1%D1%80%D1%8F%202026%20%D0%B3%D0%BE%D0%B4%D0%B0%20%D0%A2%D0%A0%D0%9E%D0%98%D0%A1%20%D0%93%D0%A2%D0%A1.pdf"}
{"href":"/site/x/_/attachment/inline/d550:0e2a/%D0%A1%D0%9E%D0%93%D0%9B%D0%90%D0%A8%D0%95%D0%9D%D0%98%D0%95.pdf"}`;
assert.deepEqual(w.troisFiles(troisHtml.replace(/"href":/g, '')), ['11 -16 сентября 2026 года ТРОИС ГТС.pdf'], 'только файлы с «ТРОИС» в имени');
const bills = [
  { vh_nom: '6-16490/26', vh_dat: '2026-09-23T00:00:00.000Z', zpNameRus: 'О проекте Закона «О внесении изменений … в сфере налогообложения»' },
  { vh_nom: '6-1/26', vh_dat: '2026-09-20T00:00:00.000Z', zpNameRus: 'О проекте Закона о культуре' },
  { vh_nom: '6-7473/25', vh_dat: '2025-05-01T00:00:00.000Z', zpNameRus: 'О таможенном регулировании' },
];
assert.deepEqual(w.freshBills(bills, '2026-09-03').map((b) => b.n), ['6-16490/26'], 'в окне и по теме');

// ── база: известные акты и цифры счётчика ──
const baseSrc = "imN:'Запрет · Пост. КМ КР №230 от 08.04.2026',x:'ПКМ КР № 614 от 14.09.2026 «О введении…»',"
  + "y:'Постановление Кабинета Министров КР от 09.09.2026 № 606 «О введении…», Решение от 05.12.2025 года № 111',"
  + "льгN:'по онлайн-счётчику ГТС на 23.09.2026 использовано 24 970 из 25 000 штук, остаток 30;'";
const known = w.knownActs(baseSrc);
assert.ok(known.has('230@2026-04-08'), 'номер без пробела после №');
assert.ok(known.has('614@2026-09-14'));
assert.ok(known.has('606@2026-09-09'), 'дата перед номером');
assert.ok(known.has('111@2025-12-05'), 'со словом «года»');
assert.ok(!known.has('615@2026-09-14'));
assert.deepEqual(w.baseCounter(baseSrc), { used: 24970, total: 25000, left: 30 });
assert.equal(w.baseCounter('карточка без цифр'), null);

// ── сроки: истекает в горизонте, истекло недавно, давно истёкшее не шумит ──
const base = {
  BAN_DB: [
    { name: 'Гипсокартон', im: true, imUntil: '2026-10-25' },
    { name: 'Удобрения', ex: true, exUntil: '2026-09-15' },
    { name: 'Удобрения азотные', ex: true, exUntil: '2026-09-15', exN: 'срок истёк; продление в реестре НПА и на gov.kg на 24.09.2026 не найдено' },
    { name: 'Саженцы', im: true, imUntil: '2026-06-01' },
    { name: 'Электромобили', 'льг': true, 'льгUntil': '2026-12-31' },
    { name: 'Без даты', im: true },
  ],
  ANTIDUMP_DB: [[['4011'], 'Шины', '', '', '', '', '2026-09-30'], [['7304'], 'Трубы', '', '', '', '', '2030-06-23']],
};
const due = w.datedMeasures(base, '2026-09-23', 14, 30);
assert.deepEqual(due.map((d) => [d.label.split(':')[0], d.date, d.left]), [
  ['запрет вывоза', '2026-09-15', -8],
  ['антидемпинг', '2026-09-30', 7],
]);
assert.equal(w.datedMeasures(base, '2026-10-20', 14, 30).some((d) => /Гипсокартон/.test(d.label)), true, 'за 5 дней до конца — в списке');
assert.equal(w.datedMeasures(base, '2026-09-10', 14, 30).some((d) => /азотные/.test(d.label)), true, 'до истечения — в списке, даже с пометкой о продлении');

// ── отчёт ──
const report = w.renderText({
  today: '2026-09-23', since: '2026-09-02',
  findings: [
    { kind: 'new-act', src: 'gov.kg', text: 'ПКМ № 614 от 14.09.2026 — в базе не упомянуто' },
    { kind: 'expiry', src: 'база', text: 'антидемпинг: Шины — истекает 30.09.2026' },
  ],
  errors: ['ГТС: таймаут'],
});
assert.match(report, /^Дозор источников 23\.09\.2026 \(окно с 02\.09\.2026\)/);
assert.match(report, /## Новые акты, которых нет в базе\n- \[gov\.kg\] ПКМ № 614/);
assert.match(report, /## Сроки\n- \[база\] антидемпинг/);
assert.match(report, /## Источники, которые не ответили\n- ГТС: таймаут/);
assert.doesNotMatch(report, /## Счётчики/);
assert.match(w.renderText({ today: '2026-09-23', since: '2026-09-02', findings: [], errors: [] }), /Находок нет\./);

console.log('PASS: gov.kg — таблица и карточка; реестр — только ПКМ; счётчик ГТС среди виджетов; справочники НСИ; реестр мер защиты ЕЭК; слепые пятна дат; ЕТТ ЕЭК; ТРОИС и законопроекты; известные акты и цифры базы; сроки с горизонтом и льготным окном; текст отчёта');
