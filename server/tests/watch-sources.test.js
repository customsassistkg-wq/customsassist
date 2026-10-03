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

// ── акты, которых база ждёт в реестре (REG_PENDING) ──
const pending = { num: '615', adopted: '2026-09-14', what: 'ПКМ № 615 от 14.09.2026 (проба)' };
assert.match(w.pendingFinding(pending, acts), /^ПКМ № 615 от 14\.09\.2026 \(проба\): акт появился в реестре НПА — https:\/\/cbd\.minjust\.gov\.kg\/7-58169\/edition\/58961\/ru; заменить ссылку/);
assert.equal(w.pendingFinding({ ...pending, adopted: '2026-09-15' }, acts), null, 'тот же номер другого дня — не он');
assert.equal(w.pendingFinding({ ...pending, num: '700' }, acts), null, 'распоряжение № 700-р в разбор не попадает — parseRegistry берёт только постановления');
assert.equal(w.pendingFinding(pending, []), null, 'ещё нет в реестре — молчит');
assert.ok(w.REG_PENDING.every((p) => /^\d+$/.test(p.num) && /^\d{4}-\d\d-\d\d$/.test(p.adopted) && p.what), 'список ожидаемых актов — номер, дата, что заменить');

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
const riceGaps = w.dataGaps({ QUOTA_DB: [[['1006'], 'Рис (Вьетнам)', 2027], [['0406'], 'Сыры (Сербия)', '2025-2027']] }, '2026-09-24');
assert.deepEqual(riceGaps, ['квота «Рис (Вьетнам)» есть на 2027 год, а на текущий 2026 в базе нет'], 'следующий год без текущего; диапазон покрывает текущий');
// примечание строки «на 2027 год … не найдено» — решение на следующий год уже искали, находка молчит; про другой год — не считается
const searchedGaps = w.dataGaps({ QUOTA_DB: [
  [['0201'], 'Говядина — льгота', 2026, 'тыс. тонн', {}, 'Сверено 01.10.2026. На 2027 год решения о льготе на портале не найдено (проверено 01.10.2026; решения Совета — по №107).'],
  [['0701'], 'Картофель (Иран)', 2026, 'тыс. тонн', {}, 'на 2026 год решения не найдено'],
] }, '2026-10-02');
assert.deepEqual(searchedGaps, ['квота «Картофель (Иран)» есть только по 2026 год — решения на 2027 в базе нет'], '«на следующий год … не найдено» в примечании гасит находку');
// переключение по дате (8112 92 410 0 → 410 1 / 410 9 с 08.10.2026): за неделю и после — пока в базе прежняя разметка
const swBase = { TNVED_MAP: { 8112924101: { b: 'gone' } } };
assert.ok(w.dataGaps(swBase, '2026-10-02').some((t) => /8112 92 410 0 исключён.*claude\/ett-8112-split/.test(t)), 'за неделю до 08.10.2026 — напоминание');
assert.ok(!w.dataGaps(swBase, '2026-09-24').some((t) => /8112 92 410/.test(t)), 'раньше недели — нет');
assert.ok(!w.dataGaps({ TNVED_MAP: {} }, '2026-10-10').some((t) => /8112 92 410/.test(t)), 'правка внесена — нет');
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

// ── решения Коллегии и Совета ЕЭК: предмет в заголовке или изменение решения, на которое ссылается база ──
const eecItem = (id, n, title, adopted, pub, inForce = '') => `<div class="DocSearchResult_Item">
  <div class="DocSearchResult_Item__Date">Акты ЕЭК &ndash; Коллегия &ndash; Решения &ndash; 2026</div>
  <a target="_blank" href="/documents/463/${id}/" class="DocSearchResult_Item__Link">Решение Коллегии ЕЭК № ${n}   </a>
  <div class="DocSearchResult_Item__Text">   ${title}   </div>
  <div class="DocSearchResult_Item__Dates"><div class="DocSearchResult_Item__DatesLeft">
  <div>Дата принятия документа: ${adopted}</div><div>Дата опубликования документа: ${pub}</div></div>
  <div class="DocSearchResult_Item__DatesRight">${inForce && `<div>Дата вступления в силу: ${inForce}</div>`}</div></div></div>`;
const eecHtml = '<div class="DocSearchResult_Items">' + [
  eecItem(10954, 125, 'О внесении изменения в Решение Коллегии Евразийской экономической комиссии от 20 декабря 2022 г. № 197', '29.09.2026', '30.09.2026'),
  eecItem(10924, 123, 'О внесении изменений в Решение Коллегии Евразийской экономической комиссии от 25 сентября 2023 г. № 143', '21.09.2026', '23.09.2026'),
  eecItem(10923, 122, 'О внесении изменений в подраздел 1.1 классификатора льгот по уплате таможенных платежей', '21.09.2026', '23.09.2026', '23.10.2026'),
  eecItem(10918, 121, 'О продлении действия антидемпинговой меры в отношении сварных труб', '08.09.2026', '10.09.2026'),
  eecItem(10913, 116, 'О внесении изменений в перечень стандартов … технического регламента Таможенного союза «О безопасности пищевой продукции»', '08.09.2026', '10.09.2026'),
  eecItem(10886, 107, 'О классификации тепловизионного прицела в соответствии с единой Товарной номенклатурой', '18.08.2026', '20.09.2026'),
  eecItem(10896, 113, 'О применении ставок ввозных таможенных пошлин в отношении товаров из ОАЭ', '25.08.2026', '28.08.2026'),
].join('') + '</div>';
const eecItems = w.parseEecList(eecHtml);
assert.equal(eecItems.length, 7);
assert.deepEqual(eecItems[2], { num: '122', url: 'https://docs.eaeunion.org/documents/463/10923/', title: 'О внесении изменений в подраздел 1.1 классификатора льгот по уплате таможенных платежей', adopted: '2026-09-21', pub: '2026-09-23', inForce: '2026-10-23' });
assert.deepEqual(w.refActs(eecItems[0].title + '; от 3 мая 2020 г. № 5, от 1 марта 2024 г. № 7'), ['197@2022-12-20', '5@2020-05-03', '7@2024-03-01']);
const eecKnown = new Set(['197@2022-12-20', '121@2026-09-08']);
assert.deepEqual(w.eecNew(eecItems, eecKnown, '2026-09-09', {}).map((d) => [d.num, d.amends]),
  [['125', ['197@2022-12-20']], ['122', []]],
  'изменение решения из базы — по ссылке; льготы — по предмету; известное, чужое изменение, стандарты, классификация и старое — нет');
assert.deepEqual(w.eecNew(eecItems, eecKnown, '2026-09-09').map((d) => d.num), ['125'], 'разобранное (EEC_REVIEWED) молчит');
// «некоторые решения Комиссии Таможенного союза» без номера — предмет базы (Совет № 18 от 30.01.2026, льгота на говядину)
const ktsItems = w.parseEecList(eecItem(10525, 18, 'О внесении изменений в некоторые решения Комиссии Таможенного союза в отношении отдельных видов мяса крупного рогатого скота', '30.01.2026', '26.02.2026', '08.03.2026'));
assert.deepEqual(w.eecNew(ktsItems, new Set(), '2026-02-01', {}).map((d) => [d.num, d.amends]), [['18', []]], 'изменение решений КТС без номера — находка по предмету');

// ── файл реестра односторонних мер на странице ЕЭК: путь medialibrary меняется с каждой загрузкой ──
assert.deepEqual(w.interimFiles('<a href="https://eec.eaeunion.org/upload/medialibrary/edd/abc/2024_2026.pdf" class="btn"> <a href="/upload/medialibrary/f00/x.pdf">'),
  ['https://eec.eaeunion.org/upload/medialibrary/edd/abc/2024_2026.pdf', 'https://eec.eaeunion.org/upload/medialibrary/f00/x.pdf']);
assert.match(w.KG_SEEN.unimeas, /^https:\/\/eec\.eaeunion\.org\/upload\/medialibrary\/.+\.pdf$/);

// ── редакции реестра НПА, на которые ссылается база: код → множество id, из обоих файлов ──
const linkedEds = w.kgLinkedEditions(
  "u:'https://cbd.minjust.gov.kg/7-20912/edition/51297/ru' … https://cbd.minjust.gov.kg/7-20912/edition/51297/ru",
  "stroymat18:'https://cbd.minjust.gov.kg/4-4095/edition/864081/ru', x:'https://cbd.minjust.gov.kg/7-20912/edition/49000/ru', y:'https://cbd.minjust.gov.kg/act/view/ru-ru/1'");
assert.deepEqual([...linkedEds].map(([c, s]) => [c, [...s]]), [['7-20912', [51297, 49000]], ['4-4095', [864081]]]);

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

// ── реестр НПА: указы Президента (мораторий на рыбу пришёл указом, а не постановлением) ──
const ukazReg = { totalResultsCount: 2, data: [
  { documentCode: '230048632', lastEdition: 55946, nameRu: 'Указ Президента КР от 17 июля 2026 года № 261 "О введении моратория на промысловое рыболовство в озерах Иссык-Куль и Сон-Куль"', vid: 'Указ', organ: 'Президент', dateAdopted: '2026-07-17T00:00:00' },
  registry.data[0],
] };
const uk = w.parseRegistry(ukazReg, 'ukaz');
assert.equal(uk.length, 1, 'из указов — только указ Президента');
assert.equal(uk[0].num, '261');
assert.equal(uk[0].edition, 55946, 'редакция — чтобы прочитать текст');
assert.ok(!w.TRADE_RE.test(uk[0].title), 'заголовок моратория о вывозе не говорит — указ читается целиком');
assert.ok(w.TEXT_RE.test('Объявить с 21 июля 2026 года по 21 июля 2029 года временный запрет (мораторий) на промысловую добычу, транспортировку, реализацию, хранение, приобретение и вывоз всех видов рыб'), 'текст УП № 261');
assert.ok(w.TEXT_RE.test('Ввести временный запрет сроком на шесть месяцев на вывоз угля, классифицируемого кодами 2701, 2702 ТН ВЭД ЕАЭС'), 'текст ПКМ № 430 с общим заголовком');
assert.ok(!w.TEXT_RE.test('за исключением накладных расходов, связанных с уплатой таможенного сбора, пошлин и налогов при ввозе лекарственных средств'), 'мимоходом упомянутые пошлины — не мера (ПКМ № 609)');
assert.ok(!w.TEXT_RE.test('Утвердить Порядок рассмотрения применения исключений из временного моратория на повышение тарифов, сборов, стоимости услуг (работ) и иных платежей для населения'), 'мораторий на тарифы — не мера (ПКМ № 634)');
assert.ok(!w.TEXT_RE.test('О внесении изменения в Указ Президента Кыргызской Республики «О введении временного запрета (моратория) на проведение проверок субъектов предпринимательства»'), 'мораторий на проверки — не мера (УП № 327)');
assert.ok(w.TEXT_RE.test('Установить временный запрет, вводимый по истечении трех дней после вступления в силу настоящего постановления, сроком на шесть месяцев на вывоз из Кыргызской Республики'), 'ПКМ № 397');
assert.equal(String(w.parseRegistry(registry)[0].edition), '58961', 'у постановления тоже есть редакция');

// ── реестр НПА: последняя редакция — по editionCode, а не по id (id редакций идут не по времени) ──
const card94 = { editions: [{ editionCode: 50, id: 1289308, nameRus: '13.09.2023' }, { editionCode: 110, id: 44248, nameRus: '28.08.2025' }, { editionCode: 120, id: 44256, nameRus: '18.12.2025' }], documentReferences: new Array(34).fill({}) };
assert.deepEqual(w.docEditions(card94), { last: { id: 44256, date: '18.12.2025' }, count: 3, refs: 34 }, 'последняя редакция ПКМ № 94 — 44256');
assert.deepEqual(w.docEditions({ data: card94 }).last.id, 44256, 'ответ в обёртке data');
assert.equal(w.docEditions({}).last, null, 'без редакций');
assert.equal(w.KG_SEEN.docs[159100].seen.edition, 59576, 'ставки акциза сверены по редакции 59576 (ПКМ № 639 от 25.09.2026)');
// ПКМ № 658 от 30.09.2026 проходит TRADE_RE только названиями ГНС и ГТС в заголовке — разобран, базу не меняет, в KG_REVIEWED
assert.ok(w.TRADE_RE.test('О внесении изменений в постановление Кабинета Министров Кыргызской Республики «О вопросах Государственной налоговой службы при Кабинете Министров Кыргызской Республики и Государственной таможенной службы при Кабинете Министров Кыргызской Республики»'));
assert.ok(w.KG_REVIEWED['658@2026-09-30'], 'разобранный акт без мер о товарах не приходит каждый день');
// заголовок ПКМ № 811 «… в сфере налогообложения» раньше не проходил фильтр — изменение ставок акциза терялось
assert.ok(w.TRADE_RE.test('О внесении изменений в некоторые решения Кабинета Министров Кыргызской Республики в сфере налогообложения'));

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
