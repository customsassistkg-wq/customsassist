// node server/tests/lookup-filter.test.js
// «Справка по товару»: разбор страны и отбор карточек по направлению/стране.
// Часть в vm проверяет чистые функции без браузера; часть с реальным Edge
// включается переменной PLAYWRIGHT_MODULE (как в checker-access.test.js) и
// проходит весь путь: вход → страница справки → фильтр выдачи.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const session = require('express-session');
const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'tnved_checker.html'), 'utf8');
const code = fs.readFileSync(path.join(root, 'server/private/checker.js'), 'utf8');
// База (карточки, перечни, ставки) с 17.09.2026 — отдельный файл только для сервера.
const baseCode = fs.readFileSync(path.join(root, 'server/private/base.js'), 'utf8');

// ── Разбор страны (чистые функции, DOM не нужен) ──
const noop = ()=>{};
// Заглушка DOM ровно такая, какая нужна верхнему уровню скрипта: он вешает
// несколько обработчиков. Ничего из проверяемого ниже DOM не трогает.
const el = ()=>({addEventListener:noop, classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},
  style:{}, dataset:{}, appendChild:noop, setAttribute:noop, getAttribute:()=>null,
  querySelector:()=>null, querySelectorAll:()=>[], innerHTML:'', value:'', textContent:''});
const sandbox = {console, setTimeout, clearTimeout, addEventListener:noop, localStorage:{getItem:()=>null,setItem:noop},
  document:{getElementById:el, querySelector:el, querySelectorAll:()=>[], createElement:el, addEventListener:noop, body:el()}};
sandbox.window = sandbox;
vm.createContext(sandbox);
new vm.Script(code).runInContext(sandbox);
new vm.Script(baseCode + '\nthis.__lk={vatFreeHits,calcWarnings,BATCH_REQS,renderHtml,lkCountry,lkCtyMatch,LK_EAEU,lkPrefRates,ETT_DB,ETT_VN_DB,ETT_IRAN_DB,banOn,BAN_DB,umTermEnded,adActive,ANTIDUMP_DB};').runInContext(sandbox);
const {vatFreeHits, lkCountry, lkCtyMatch, lkPrefRates, ETT_DB, ETT_VN_DB, ETT_IRAN_DB, banOn, BAN_DB, umTermEnded, adActive, ANTIDUMP_DB} = sandbox.__lk;

// ── Антидемпинговые меры и тарифные льготы: машинная дата окончания у каждой ──
for (const r of ANTIDUMP_DB) {
  assert.equal(r.length, 7, `поле срока у меры ${r[2]}`);
  assert.match(r[6], /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(r[5] === null || /^https?:\/\//.test(r[5]), `ссылка не сдвинулась у меры ${r[2]}`);
}
{
  const tyres = ANTIDUMP_DB.find((r) => r[2] === 'Грузовые шины');
  assert.equal(adActive(tyres, '2026-11-13'), true);
  assert.equal(adActive(tyres, '2026-11-14'), false);
  for (const r of BAN_DB) if (r['льг']) assert.match(r['льгUntil'] || '', /^\d{4}-\d{2}-\d{2}$/, `срок льготы ${r.codes[0]}`);
  const beef = BAN_DB.find((r) => r['льг'] && r.codes[0] === '0201');
  assert.equal(banOn(beef, 'льг', beef['льгUntil']), true);
  assert.equal(banOn(beef, 'льг', '2099-01-01'), false);
}

// ── Односторонние меры: признак «действует» из реестра не переживает свой срок ──
assert.equal(umTermEnded('с 10.03.2026 до 10.09.2026', '2026-09-10'), false);
assert.equal(umTermEnded('с 10.03.2026 до 10.09.2026 с 29.05.2026', '2026-09-11'), true);
assert.equal(umTermEnded('бессрочно', '2030-01-01'), false);
assert.equal(umTermEnded('с 01.01.2026 по 31.12.2026', '2026-12-31'), false);

// ── Сроки запретов: последний день включительно, до даты начала — не действует ──
{
  const e = {ex:true, exUntil:'2026-09-10', im:true, imFrom:'2027-04-02'};
  assert.equal(banOn(e, 'ex', '2026-09-10'), true);
  assert.equal(banOn(e, 'ex', '2026-09-11'), false);
  assert.equal(banOn(e, 'im', '2027-04-01'), false);
  assert.equal(banOn(e, 'im', '2027-04-02'), true);
  assert.equal(banOn({ex:true}, 'ex', '2099-01-01'), true);   // бессрочный
  assert.equal(banOn({ex:false}, 'ex', '2026-01-01'), false);
  // у каждого запрета, чей текст называет «до/по ДД.ММ.ГГГГ», есть машинный срок — иначе истёкший останется красным
  for (const r of BAN_DB) for (const side of ['ex', 'im']) {
    const t = r[side + 'N'] || '';
    if (!r[side] || !/^Запрет на (вывоз|ввоз)[^·]*\s(до|по)\s\d{2}\.\d{2}\.\d{4}/.test(t)) continue;
    if (/бессрочн/i.test(t)) continue; // срок постановления есть, но запрет продолжает бессрочный акт (7204 — Указ УП№375)
    assert.ok(r[side + 'Until'], `нет ${side}Until у запрета ${r.codes[0]}: ${t.slice(0, 60)}`);
  }
  console.log('PASS: сроки запретов — последний день включительно, дата начала, у датированных запретов есть срок');
}

// Ставка НДС 0% по решениям КМ (ПКМ № 816, прил. 1 — по коду до 31.12.2027; прил. 2 и № 249 — по условию).
if (new Date().toISOString().slice(0, 10) <= '2027-12-31') {
  assert.match(vatFreeHits('0201100001').firm.map((e) => e.src).join(), /ставка НДС 0% — ПКМ КР № 816/, 'говядина — 0% по коду');
  assert.equal(vatFreeHits('1001190000').firm.length, 0, 'пшеница — 0% только по условию');
  assert.ok(vatFreeHits('1001190000').cond.length >= 2, 'условия ПКМ № 816 прил. 2 и № 249');
  assert.equal(vatFreeHits('0201').firm.length, 0, 'по позиции целиком 0% не утверждается');
  console.log('PASS: ставка НДС 0% — безусловная по коду, условная по субъекту и цели');
}
{
  const { calcWarnings, BATCH_REQS, renderHtml } = sandbox.__lk;
  const H = (q, d) => renderHtml(q, d).html;
  // Период НДС 0% — на дату проверки: солома 1213 — с 1 ноября по 1 апреля.
  assert.doesNotMatch(H('1213000000', '2026-12-01'), /на дату проверки не действует/);
  assert.match(H('1213000000', '2026-07-01'), /на дату проверки не действует/);
  // Запрет законом КР виден калькулятору и сводке партии, не только карточке.
  assert.ok(calcWarnings('8543400000').some((w) => /Законодательство КР: Электронные сигареты/.test(w.text)), 'калькулятор: электронные сигареты');
  assert.ok(BATCH_REQS.find((r) => r.k === 'natreq').f('5608118000'), 'партия: синтетические сети');
  // Вывозная пошлина по коду ПП № 479 прежней номенклатуры доходит до действующего через TNVED_MAP.
  assert.match(H('8112610000'), /Отходы и лом кадмиевые \[в перечне — код 8107 30 000 0, в действующем ЕТТ — 8112 61 000 0\]/);
  assert.match(H('8112610000'), /data-except-cty="армения беларусь казахстан россия/);
  // Маркировка: служебных пометок на карточке нет, воды общепита к ввозу не относятся, масло 3403 — по ПКМ № 179.
  assert.doesNotMatch(H('2202100000'), /banFrom|не выводить|общественного питания/);
  assert.match(H('3403199000'), /в ред\. ПКМ № 179 от 04\.04\.2025/);
  // Прослеживаемость — учёт, а не запрет: слово «запрет» в тегах увело бы карточку в «Запреты».
  assert.doesNotMatch(H('8528721000'), /Прослеживаемость — учёт, не запрет/);
  // Отменённый Закон КР «О таможенном тарифе» № 173 не называется основанием.
  assert.doesNotMatch(H('Азербайджан').replace(/<div class="audit[\s\S]*$/, ''), /DOC_SOURCES|4-5161\/edition/);
  console.log('PASS: НДС 0% на дату, закон КР в калькуляторе и партии, вывозная пошлина по TNVED_MAP, маркировка без пометок');
}

assert.equal(lkCountry(''), null);
assert.equal(lkCountry('Ки'), null);              // слишком коротко — не гадаем
assert.equal(lkCountry('Казахстан').eaeu, true);
assert.equal(lkCountry('Беларусь').eaeu, true);
assert.equal(lkCountry('Китай').name, 'Китай (КНР)');
assert.equal(lkCountry('КНР').name, 'Китай (КНР)');
assert.equal(lkCountry('Бангладеш').estp, true);  // наименее развитая — 0%
assert.equal(lkCountry('Вьетнам').fta, true);
assert.equal(lkCountry('Иран').estp && lkCountry('Иран').fta, true); // и ЕСТП, и соглашение
assert.equal(lkCountry('Германия').other, true);  // третья страна без преференций
assert.equal(lkCountry('Германия').estp, undefined);

// Метка карточки написана так, как страна названа в акте; ввод — обиходный.
assert.equal(lkCtyMatch('оаэ эмираты', lkCountry('ОАЭ')), true);
assert.equal(lkCtyMatch('иран', lkCountry('Иран')), true);
assert.equal(lkCtyMatch('китай кнр', lkCountry('Китай')), true);
assert.equal(lkCtyMatch('кнр украина', lkCountry('Украина')), true);
assert.equal(lkCtyMatch('кнр украина', lkCountry('Германия')), false);
assert.equal(lkCtyMatch('вьетнам', lkCountry('Германия')), false);
assert.equal(lkCtyMatch('estp', lkCountry('Бангладеш')), true);
assert.equal(lkCtyMatch('estp', lkCountry('Германия')), false);
assert.equal(lkCtyMatch('estp', lkCountry('Казахстан')), false);
console.log('PASS: разбор страны и сопоставление с меткой карточки');

// Карточки, которым проставлены признаки, должны быть именно теми мерами,
// которые при вывозе не применяются: тарифными и налоговыми.
assert.ok(baseCode.includes('data-dir="im" data-kind="tariff" data-cty="оаэ эмираты"'));
assert.ok(baseCode.includes('data-cty="estp"'));
assert.equal(baseCode.split('data-dir="im"').length - 1, 37); // +5 (18.09.2026): три карточки СЭН, опасные отходы, льгота BAN_DB; −1 (22.09.2026): УСИР убран, коэффициент КНР возвращён; +1 (24.09.2026): обязательная маркировка при ввозе; +1: ставка НДС 0% по решениям КМ; +1 (29.09.2026): ветеринарные меры против предприятий-изготовителей
console.log('PASS: признаки направления проставлены 37 карточкам');

// ── Ставка для страны происхождения (правила — по текстам решений ЕЭК) ──
const ettOf = c => (ETT_DB.find(r => r[0] === c) || [])[3];
const rate = (c, cty, date) => lkPrefRates(c, ettOf(c), lkCountry(cty), date);
// перечни внесены целиком, со строками «ставка ЕТТ»: без них код перечня
// не отличить от кода вне перечня, где действует 0%
assert.equal(ETT_VN_DB.length, 604);
assert.equal(ETT_IRAN_DB.length, 1736);
// пример владельца: говядина из ОАЭ — 13,1% по графику на 2026 год,
// но только с 06.10.2026; до этой даты — ставка ЕТТ и указание даты
let r = rate('0201100001', 'ОАЭ', '2026-09-16');
assert.equal(r[0].rate, '13,1%'); assert.equal(r[0].pending, '06.10.2026');
r = rate('0201100001', 'ОАЭ', '2026-10-06');
assert.equal(r[0].rate, '13,1%'); assert.equal(r[0].pending, undefined);
assert.equal(rate('0201100001', 'ОАЭ', '2027-03-01')[0].rate, '11,3%');
assert.equal(rate('0201100001', 'ОАЭ', '2035-01-01')[0].rate, '0%');
assert.equal(rate('8517130000', 'ОАЭ', '2026-10-10')[0].rate, '0%');           // вне перечня
assert.equal(rate('0201100001', 'Вьетнам', '2026-09-16')[0].rate, '15%');     // «ставка ЕТТ» по позиции 0201
assert.equal(rate('8471300000', 'Вьетнам', '2026-09-16')[0].rate, '0%');      // вне перечня — 0%, а не ЕТТ
assert.equal(rate('3304300000', 'Вьетнам', '2026-09-16')[0].rate, '6,5%');    // ставка перечня 11,3% выше ЕТТ
assert.match(rate('6103430001', 'Вьетнам', '2026-09-16')[0].basis, /триггерн/);
assert.equal(rate('0701905000', 'Иран', '2026-09-16')[0].rate, '7,5%');
assert.equal(rate('8471300000', 'Иран', '2026-09-16')[0].rate, '0%');
assert.equal(rate('8517130000', 'Сербия', '2026-09-16')[0].rate, '0%');
assert.equal(rate('0406900100', 'Монголия', '2026-09-16')[0].rate, '7%, но не менее 0,14 евро за 1 кг');  // скидка 50%
assert.equal(rate('2208601100', 'Монголия', '2026-09-16')[0].rate, '1,125 евро за 1 л 100% спирта');     // «100%» не масштабируется
assert.equal(rate('0201100001', 'Бангладеш', '2026-09-16')[0].rate, '0%');
assert.equal(rate('0201100001', 'Египет', '2026-09-16')[0].rate, '11,25%');
assert.equal(rate('0201100001', 'Германия', '2026-09-16').length, 0);
console.log('PASS: ставка по стране происхождения — ОАЭ, Вьетнам, Иран, Сербия, Монголия, ЕСТП');

// ── Зона свободной торговли СНГ: 0% по любому коду, условие — происхождение, дата — для пары «КР — страна» ──
for (const [q, n] of [['Узбекистан', 'Узбекистан'], ['узбекистана', 'Узбекистан'], ['Республика Узбекистан', 'Узбекистан'],
  ['Таджикистан', 'Таджикистан'], ['Молдавия', 'Молдова'], ['Украины', 'Украина'],
  ['Азербайджан', 'Азербайджан'], ['азербайджана', 'Азербайджан'], ['Азербайджанская Республика', 'Азербайджан']]) assert.equal(lkCountry(q).cis.n, n, q);
for (const q of ['камера', 'ткань', 'сахар', 'украшения', 'молоко', 'таджикский', 'Германия', 'Казахстан']) assert.ok(!lkCountry(q).cis, q);
r = rate('3307900008', 'Узбекистан', '2026-09-18');
assert.equal(r.length, 1);
assert.equal(r[0].rate, '0%');
assert.match(r[0].basis, /Протокол .* Республикой Узбекистан от 31\.05\.2013, п\.1 части I приложения 1/);
assert.match(r[0].note, /Правилам определения страны происхождения товаров от 24\.09\.1993/);
assert.equal(rate('3307900008', 'Узбекистан', '2017-01-01')[0].pending, '13.04.2017'); // Протокол для КР — с 13.04.2017
assert.match(rate('8212101000', 'Таджикистан', '2026-09-18')[0].note, /СТ-1/);
assert.equal(rate('2208601100', 'Молдова', '2026-09-18')[0].rate, '0%');          // изъятий у КР нет — и для водки
assert.equal(rate('3307900008', 'Казахстан', '2026-09-18').length, 0);             // ЕАЭС — не преференция, а взаимная торговля
// Азербайджан — двустороннее соглашение 2004 г. (не ЗСТ СНГ): 0%, основание — п.1 ст.102 Договора о ЕАЭС и ст.8 Закона о таможенном тарифе
r = rate('8517130000', 'Азербайджан', '2026-09-22');
assert.equal(r.length, 1);
assert.deepEqual([r[0].rate, r[0].who], ['0%', 'Соглашение о свободной торговле КР–Азербайджан']);
assert.match(r[0].basis, /от 12\.01\.2004, ст\.1 .*п\.1 ст\.102 Договора о ЕАЭС$/);
assert.doesNotMatch(r[0].basis, /О таможенном тарифе/); // Закон КР № 173 утратил силу 01.11.2022 (Закон КР № 100)
assert.match(r[0].note, /СТ-1/);
assert.equal(rate('8517130000', 'Азербайджан', '2003-12-31')[0].pending, '12.01.2004'); // временное применение со дня подписания
const az = sandbox.__lk.renderHtml('Азербайджан', '').html;
assert.match(az, /Двустороннее соглашение о свободной торговле: ввозная пошлина не применяется/);
assert.match(az, /cbd\.minjust\.gov\.kg\/17625\/edition\/297684\/ru/);
assert.doesNotMatch(az, /Зона свободной торговли СНГ:/);
// Грузия (только РНБ) и Туркменистан (торгового соглашения нет) — не преференция: карточки страны нет
assert.doesNotMatch(sandbox.__lk.renderHtml('Грузия', '').html, /пошлина не применяется/);
assert.ok(!lkCountry('Грузия').cis && !lkCountry('Туркменистан').cis);
console.log('PASS: зона свободной торговли СНГ — Узбекистан по Протоколу, Таджикистан, Молдова, Украина; Азербайджан — по двустороннему соглашению');

if (!process.env.PLAYWRIGHT_MODULE) {
  console.log('SKIP: браузерная часть (задайте PLAYWRIGHT_MODULE)');
  return;
}

// ── Браузер: настоящий вход и настоящая выдача ──
const user = {id:'valid', email:'test@example.test', role:'user', active:true, email_verified_at:new Date(), last_seen_at:new Date()};
require.cache[require.resolve('../src/db')] = {exports:{pool:{query:async()=>({rows:[user]})}}};
const app = express();
app.use(express.json());
app.use(session({secret:'local-check-only', resave:false, saveUninitialized:false}));
app.use(require('../src/middleware/auth'));
app.get('/api/auth/config', (req,res)=>res.json({}));
app.get('/api/auth/me', (req,res)=>req.user?res.json({...req.user,emailVerified:true,termsAccepted:true}):res.status(401).json({}));
app.post('/api/auth/login', (req,res)=>{req.session.userId='valid';res.json({...user,emailVerified:true,termsAccepted:true});});
app.get('/api/nbkr-rates', (req,res)=>res.status(503).json({}));
app.get('/api/class-decisions', (req,res)=>res.json({items:[]}));
app.use('/api/checker.js', require('../src/routes/checker'));
app.use('/api/engine', require('../src/routes/engine'));
app.get('/', (req,res)=>res.type('html').send(html));

(async()=>{
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await require(process.env.PLAYWRIGHT_MODULE).chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);
    await page.locator('#authEmail').fill('test@example.test');
    await page.locator('#authPassword').fill('valid');
    await page.locator('#authSubmit').click();
    await page.locator('#appWrap').waitFor({state:'visible'});
    // Условия стоят под полем поиска в порядке принятия решения: направление, страна, дата.
    assert.deepEqual(await page.evaluate(()=>Array.from(document.querySelectorAll('#srchCond select,#srchCond input')).map(e=>e.id)),
      ['lookupDir','lookupCty','lookupDate']);
    assert.deepEqual(await page.evaluate(()=>Array.from(document.querySelectorAll('#lookupDir option')).map(o=>o.textContent)),
      ['Ввоз','Вывоз','Транзит']);

    // Ждём метку «показано именно это», а не появление карточек: прежние карточки
    // остаются на экране, пока идёт новый ответ.
    const run=async(dir,cty,q)=>{
      await page.selectOption('#lookupDir',dir);
      await page.fill('#lookupCty',cty);
      await page.fill('#inp',q);
      const stamp=await page.evaluate(()=>searchStamp(document.getElementById('inp').value.trim()));
      await page.waitForFunction((s)=>document.getElementById('result').dataset.rq===s,stamp);
      return page.evaluate(()=>({
        shown:Array.from(document.querySelectorAll('#result .res-sec > .card, #result > .card')).map(c=>c.className),
        hidden:Array.from(document.querySelectorAll('.lk-hidden > .card')).map(c=>(c.querySelector('.tag')||{}).textContent||c.className),
        head:Array.from(document.querySelectorAll('#result .calc-warn')).map(w=>w.textContent).join(' | '),
      }));
    };
    const vis=(sel)=>page.evaluate((s)=>document.querySelectorAll('#result .res-sec > '+s+', #result > '+s).length,sel);

    // Меламин: антидемпинговая мера установлена в отношении товара из КНР.
    let r=await run('im','Китай','2933610000');
    assert.ok(r.hidden.every(h=>!/Антидемпинг|антидемпинг/.test(h)), 'мера КНР не должна скрываться для Китая');
    assert.ok(await vis('.card[data-cty]')>0, 'карточка со страной осталась видимой');
    r=await run('im','Германия','2933610000');
    assert.equal(await vis('.card[data-cty]'),0, 'для Германии страновые карточки убраны');
    assert.match(r.head,/Германия/);

    // Временные ветеринарные ограничения (ветслужба КР): карточки по болезням сливаются в одну, вердикт —
    // «возможно», страна прячет чужие подблоки, а страна без ограничений — всю карточку.
    const vet=()=>page.evaluate(()=>{const c=document.querySelector('#result .res-sec > .card[data-merged="vettemp"], #result > .card[data-merged="vettemp"]');
      return c?{subs:c.querySelectorAll('.sub').length,shown:c.querySelectorAll('.sub:not(.sub-hidden)').length,partial:c.dataset.partial||''}:null;});
    await run('im','','0207141000');
    let v=await vet();
    assert.ok(v&&v.subs===4&&v.shown===4&&v.partial==='1', 'грипп птиц, АЧС, тиф, Ньюкасл — одна карточка, «возможно»: '+JSON.stringify(v));
    await run('im','Польша','0207141000');
    v=await vet();
    assert.ok(v&&v.shown===3, 'для Польши — грипп птиц (воеводства), АЧС и болезнь Ньюкасла: '+JSON.stringify(v));
    await run('im','Египет','0207141000');
    assert.equal(await vet(),null,'для страны без ограничений карточки нет');
    await run('ex','','0207141000');
    assert.equal(await vet(),null,'ограничения ввоза не показываются при вывозе');

    // Обязательная маркировка: требование при ввозе — видна при ввозе, скрыта при транзите.
    const mark=()=>page.evaluate(()=>Array.from(document.querySelectorAll('#result .res-sec > .card, #result > .card')).some(c=>/Обязательная маркировка при ввозе/.test(c.textContent)));
    await run('im','','2402200000');
    assert.equal(await mark(),true,'сигареты: карточка маркировки при ввозе');
    await run('tr','','2402200000');
    assert.equal(await mark(),false,'при транзите маркировка не требуется');

    // Запрет законом КР, где коды — толкование слов акта: в «Запретах», но вердикт — «возможный», не красный.
    await run('im','','8543400000');
    const vape=await page.evaluate(()=>({card:Array.from(document.querySelectorAll('#result .card')).some(c=>/Запрет по законодательству КР: Электронные сигареты/.test(c.textContent)&&c.dataset.partial==='1'),red:!!document.querySelector('#result .vd-danger')}));
    assert.ok(vape.card,'электронные сигареты: карточка запрета законом с пометкой «проверьте по наименованию»');
    assert.equal(vape.red,false,'вердикт не красный — коды сопоставлены по смыслу');

    // Вывозная пошлина КР (data-dir="ex"): видна при вывозе, скрыта при транзите. При ввозе без страны
    // фильтр не применяется вовсе (показывается всё — как и запреты вывоза), поэтому ввоз здесь не проверяется.
    const expDuty=()=>page.evaluate(()=>Array.from(document.querySelectorAll('#result .res-sec > .card, #result > .card')).some(c=>/Вывозная таможенная пошлина Кыргызской Республики/.test(c.textContent)));
    await run('ex','','4101200000');
    assert.equal(await expDuty(),true,'шкуры: вывозная пошлина при вывозе');
    await run('tr','','4101200000');
    assert.equal(await expDuty(),false,'при транзите вывозной пошлины нет');
    // Вывоз в ЕАЭС: п.2 акта — пошлина не применяется; карточка остаётся «возможной» с текстом исключения.
    await run('ex','Казахстан','4101200000');
    const expEaeu=await page.evaluate(()=>{const c=Array.from(document.querySelectorAll('#result .card')).find(c=>/Вывозная таможенная пошлина Кыргызской Республики/.test(c.textContent));return c?{partial:c.dataset.partial||'',why:/акт содержит исключение/.test(c.textContent)}:null;});
    assert.ok(expEaeu&&expEaeu.partial==='1'&&expEaeu.why,'вывоз в Казахстан: исключение п.2 акта '+JSON.stringify(expEaeu));

    // Прослеживаемость — учёт, не запрет: карточка не в «Запретах», вердикт не красный (до 29.09.2026 был красным).
    await run('im','','8528721000');
    const trace=await page.evaluate(()=>{const c=Array.from(document.querySelectorAll('#result .card')).find(c=>/Прослеживаемость ЕАЭС/.test(c.textContent));return {sec:c&&c.closest('.res-sec')?c.closest('.res-sec').id:'',red:!!document.querySelector('#result .vd-danger')};});
    assert.notEqual(trace.sec,'res-sec-danger','прослеживаемость не в «Запретах»');
    assert.equal(trace.red,false,'телевизор: вердикт не красный');

    // Страна ЕАЭС тоже прячет чужие подблоки объединённой карточки (до 29.09.2026 — только третьи страны).
    await run('im','Россия','0207141000');
    v=await vet();
    assert.ok(v===null||v.shown<v.subs,'для России — только её ветограничения: '+JSON.stringify(v));

    // Страна ЗСТ СНГ и Азербайджан: плашка 0% на карточке ЕТТ появляется после ответа lkRates — до 22.09.2026
    // lkApplyRates выходил на «нет pref», и для них показывалась только синяя подсказка.
    const plaque=async(cty,text)=>{
      await run('im',cty,'8517130000');
      await page.waitForFunction((t)=>document.getElementById('result').innerHTML.indexOf(t)>=0,text,{timeout:15000});
    };
    await plaque('Узбекистан','ЗСТ СНГ (Узбекистан): <b>0%</b>');
    await plaque('Азербайджан','Соглашение о свободной торговле КР–Азербайджан: <b>0%</b>');

    // Вывоз: ставка ЕТТ и льготы по НДС к нему не относятся.
    r=await run('ex','','8517130000');
    assert.equal(await vis('.card[data-dir="im"]'),0);
    assert.ok(await page.evaluate(()=>document.querySelectorAll('.lk-hidden > .card[data-dir="im"]').length>0));
    assert.match(r.head,/вывоз/i);
    // Вердикт и секции пересобраны без скрытых карточек.
    assert.ok(await page.evaluate(()=>!document.querySelector('#res-sec-pay')),'секция платежей при вывозе пуста и убрана');

    // Транзит: то же самое, но с основанием из ТК ЕАЭС.
    r=await run('tr','','8517130000');
    assert.equal(await vis('.card[data-dir="im"]'),0);
    assert.match(r.head,/142/);

    // Ввоз из ЕАЭС: взаимная торговля — тарифных мер нет, запреты остаются.
    r=await run('im','Казахстан','8517130000');
    assert.equal(await vis('.card[data-kind="tariff"]'),0);
    assert.match(r.head,/Казахстан/);

    // Без страны и при ввозе не скрывается ничего и баннера нет.
    r=await run('im','','8517130000');
    assert.equal(await page.evaluate(()=>document.querySelectorAll('.lk-hidden').length),0);
    assert.equal(r.head,'');

    // Смена условия перезапускает текущий запрос сама.
    await page.selectOption('#lookupDir','ex');
    await page.waitForFunction(()=>document.getElementById('result').dataset.rq==='8517130000|ex||'+document.getElementById('lookupDate').value);
    assert.equal(await vis('.card[data-dir="im"]'),0);

    // Клик по кандидату из списка «по наименованию» сохраняет условия.
    await run('ex','','смартфон');
    await page.locator('#result [onclick^="goToCode"]').first().click();
    await page.waitForFunction(()=>/^\d{10}\|ex\|/.test(document.getElementById('result').dataset.rq||''));
    assert.equal(await page.inputValue('#lookupDir'),'ex');

    // Ставка для ОАЭ в карточке ЕТТ: до 06.10.2026 — ЕТТ и дата, с 06.10.2026 — 13,1%
    await page.fill('#lookupDate','2026-09-16');
    await run('im','ОАЭ','0201100001');
    await page.locator('#result .pref-rate').first().waitFor();
    assert.match(await page.locator('#result .pref-rate').first().innerText(),/06\.10\.2026[\s\S]*13,1%/);
    await page.fill('#lookupDate','2026-10-06');
    await page.locator('#lookupDate').dispatchEvent('change');
    await page.locator('#result .ett-was').first().waitFor();
    assert.match(await page.locator('#result .ett-rate').first().innerText(),/15%\s*13,1%/);

    assert.deepEqual(errors,[]);
    console.log('PASS: браузер — порядок полей, три направления, страна происхождения, ЕАЭС');
  }finally{
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
