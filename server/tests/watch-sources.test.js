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

console.log('PASS: gov.kg — таблица и карточка; реестр — только ПКМ; счётчик ГТС среди виджетов; справочники НСИ; известные акты и цифры базы; сроки с горизонтом и льготным окном; текст отчёта');
