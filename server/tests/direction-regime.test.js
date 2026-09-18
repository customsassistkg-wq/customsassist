// node server/tests/direction-regime.test.js
// Правовой режим по направлению: карточка запрета несёт направление, «из»/неподтверждённое/исключение —
// не запрет, дата проверки доходит до карточек, разрешительный порядок Единого перечня — по разделу,
// несуществующий код называется. Регрессия на аудит 18.09.2026 (session.md).
const assert = require('node:assert/strict');
const path = require('node:path');
const { load } = require(path.join(__dirname, '../src/services/base'));
const b = load();

const cards = (q, date) => [...b.renderHtml(q, date).html.matchAll(/<div class="card ([^"]*)"([^>]*)>([\s\S]*?)(?=<div class="card |$)/g)]
  .map((m) => ({ cls: m[1], attrs: m[2], body: m[3], tags: [...m[3].matchAll(/<span class="tag [^"]*">([\s\S]*?)<\/span>/g)].map((x) => x[1].replace(/<[^>]+>/g, '')) }));
// только карточки BAN_DB: у Единого перечня и опасных отходов свои теги «Запрет ввоза (ЕАЭС)»
const ban = (q, date) => cards(q, date).filter((c) => !/Опасные отходы, запрещённые|Единые меры нетарифного регулирования/.test(c.body) && c.tags.some((t) => /запрета? (вывоза|ввоза)/i.test(t)));

// ── ППКР № 66 в ред. ПКМ № 615 от 14.09.2026: 2711 и 2901 запрещены к вывозу с 18.09.2026 ──
for (const q of ['2711210000', '2901100000']) {
  const bx = ban(q, '2026-09-18');
  assert.ok(bx.some((c) => /data-dir="ex"/.test(c.attrs) && !/data-partial/.test(c.attrs) && c.tags.includes('⛔ Запрет вывоза')), q + ': запрет вывоза с направлением ex');
  const before = ban(q, '2026-09-17');
  assert.ok(!before.some((c) => c.tags.includes('⛔ Запрет вывоза')), q + ': до 18.09.2026 запрета не было');
  assert.ok(before.some((c) => c.tags.some((t) => /⏸ Запрет вывоза действует с 18\.09\.2026/.test(t))), q + ': дата начала названа');
}
// смазочные масла подп.5 п.1 — исключение при условии, не ⛔
{
  const c = ban('2710198200').find((c) => /2709\) и нефтепродукты/.test(c.body));
  assert.ok(c && /data-partial="1"/.test(c.attrs) && c.tags.some((t) => /Исключение из запрета вывоза/.test(t)), 'масла — исключение');
  assert.match(c.body, /Исключение:<\/strong> подп\.5 п\.1/);
}
console.log('PASS: нефтепродукты — редакция ПКМ № 615, дата начала, исключение по маслам');

// ── «из» в акте: не ⛔, а проверка; гипсокартон — только 6809 11 000 0 ──
for (const [q, word] of [['2620110000', 'вывоза'], ['2309903100', 'ввоза'], ['3815120000', 'вывоза']]) {
  const bx = ban(q);
  assert.ok(bx.length, q + ': карточка есть');
  assert.ok(bx.every((c) => /data-partial="1"/.test(c.attrs) && c.tags.some((t) => t.includes('Возможный запрет ' + word))), q + ': «из» — возможный запрет');
}
assert.equal(ban('6809190000').length, 0, '6809 19 000 0 не под запретом № 230');
{
  const c = ban('6809110000')[0];
  assert.ok(c && /data-except-eaeu="1"/.test(c.attrs) && c.tags.includes('⚠️ Запрет ввоза'), 'гипсокартон: запрет с исключением для ЕАЭС');
  assert.match(c.body, /государств-членов ЕАЭС/);
}
{
  const c = cards('2804100000').find((c) => /Гелий/.test(c.body));
  assert.ok(c && !c.tags.includes('⛔ Запрет вывоза') && c.tags.some((t) => /не подтверждён первоисточником/.test(t)), 'гелий без основания — не запрет');
}
console.log('PASS: «из», исключение ЕАЭС, неподтверждённая строка');

// ── направление у карточек запрета и Единого перечня ──
assert.ok(ban('2404120000').every((c) => /data-dir="im"/.test(c.attrs)), 'запрет ввоза несёт im');
assert.ok(ban('0102').every((c) => /data-dir="ex"/.test(c.attrs)), 'запрет вывоза несёт ex');
const lic = (q) => cards(q).filter((c) => /Разрешительный порядок ЕАЭС/.test(c.body)).map((c) => (/data-dir="([^"]*)"/.exec(c.attrs) || [])[1]);
assert.deepEqual(lic('9705220000'), ['ex'], 'разделы 2.4 и 2.20 — вывоз');
assert.ok(lic('3004900002').includes('im') && !lic('3004900002').includes('ex'), 'раздел 2.14 — ввоз (2.12 — оба)');
assert.ok(cards('3004900002').filter((c) => /Разрешительный порядок ЕАЭС/.test(c.body)).every((c) => /data-scope="third"/.test(c.attrs)), 'перечень — торговля с третьими странами');
console.log('PASS: направление запретов и разделов Единого перечня');

// ── дата проверки: односторонняя мера до даты начала не «действует» ──
{
  const on = cards('2309903100', '2026-09-18').find((c) => /Односторонние меры/.test(c.body));
  const off = cards('2309903100', '2026-09-01').find((c) => /Односторонние меры/.test(c.body));
  assert.match(on.body, /действующих — 1/);
  assert.match(off.body, /действующих нет/);
}
console.log('PASS: дата проверки доходит до реестра односторонних мер');

// ── несуществующий 10-значный код назван первым ──
assert.ok(/data-nocode="1"/.test(cards('0102290000')[0].attrs), 'кода нет — первая карточка');
assert.ok(!cards('0102291000').some((c) => /data-nocode/.test(c.attrs)), 'действующий код — без пометки');
console.log('PASS: несуществующий код');

// ── вторая партия (18.09.2026, ночь): уголь по стране назначения, НКС по закону, транзит у 2.1/2.3, реестр, НБ НДС, калькулятор ──
{
  const coal = ban('2701121000')[0];
  assert.ok(coal && /data-except-cty="китай кнр"/.test(coal.attrs) && /data-except-cty-note="[^"]*Иркештам/.test(coal.attrs), 'уголь: исключение по КНР в атрибуте');
  assert.match(coal.body, /Исключение по стране назначения:<\/strong> п\.1 ПКМ КР № 430/);
  const nks = cards('8411110000').find((c) => /Список 5/.test(c.body));
  assert.match(nks.body, /экспорт, импорт, реэкспорт и транзит/i, 'НКС: ст. 11 Закона № 30');
  const ozone = cards('2903710000').filter((c) => /Разрешительный порядок ЕАЭС/.test(c.body));
  assert.ok(ozone.some((c) => /data-dir="im ex tr"/.test(c.attrs) && /Транзит:<\/strong>/.test(c.body)), 'раздел 2.1 — и транзит');
  const uni = cards('2620110000').find((c) => /Односторонние меры/.test(c.body));
  assert.ok(uni && /data-partial="1"/.test(uni.attrs), 'реестр ЕЭК: совпадение «из» — проверка');
  const nb = cards('6809110000').find((c) => /налоговая база НДС/.test(c.body));
  assert.ok(nb && /data-eaeu-only="1"/.test(nb.attrs), 'НБ НДС — только ввоз из ЕАЭС');
  const w = b.calcWarnings('2309903100');
  assert.ok(w.some((x) => x.level === 'yellow' && /частично/.test(x.text)) && !w.some((x) => x.level === 'red'), 'калькулятор: «из» — жёлтое, не красное');
  assert.ok(b.calcWarnings('2404120000').some((x) => x.level === 'red'), 'калькулятор: точный запрет — красное');
}
console.log('PASS: уголь по стране, НКС по закону, транзит 2.1, реестр, НБ НДС, калькулятор');
