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
new vm.Script(code + '\nthis.__lk={lkCountry,lkCtyMatch,LK_EAEU,lkPrefRates,ETT_DB,ETT_VN_DB,ETT_IRAN_DB,banOn,BAN_DB,umTermEnded};').runInContext(sandbox);
const {lkCountry, lkCtyMatch, lkPrefRates, ETT_DB, ETT_VN_DB, ETT_IRAN_DB, banOn, BAN_DB, umTermEnded} = sandbox.__lk;

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
assert.ok(code.includes('data-dir="im" data-kind="tariff" data-cty="оаэ эмираты"'));
assert.ok(code.includes('data-cty="estp"'));
assert.equal(code.split('data-dir="im"').length - 1, 30);
console.log('PASS: признаки направления проставлены 30 карточкам');

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
app.get('/api/auth/me', (req,res)=>req.user?res.json({...req.user,emailVerified:true}):res.status(401).json({}));
app.post('/api/auth/login', (req,res)=>{req.session.userId='valid';res.json({...user,emailVerified:true});});
app.get('/api/nbkr-rates', (req,res)=>res.status(503).json({}));
app.get('/api/class-decisions', (req,res)=>res.json({items:[]}));
app.use('/api/checker.js', require('../src/routes/checker'));
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
    await page.locator('#navLookupBtn').click();
    await page.locator('#lookupDir').waitFor({state:'visible'});

    // Поля идут в порядке принятия решения: направление, страна, товар.
    assert.deepEqual(await page.evaluate(()=>Array.from(document.querySelectorAll('#pageLookup select,#pageLookup input')).map(e=>e.id)),
      ['lookupDir','lookupCty','lookupQuery','lookupDate']);
    assert.deepEqual(await page.evaluate(()=>Array.from(document.querySelectorAll('#lookupDir option')).map(o=>o.textContent)),
      ['Ввоз','Вывоз','Транзит']);

    const run=async(dir,cty,q)=>{
      await page.selectOption('#lookupDir',dir);
      await page.fill('#lookupCty',cty);
      await page.fill('#lookupQuery',q);
      await page.click('#pageLookup .calc-btn');
      await page.locator('#lookupCards .card').first().waitFor();
      return page.evaluate(()=>({
        shown:Array.from(document.querySelectorAll('#lookupCards > .card')).map(c=>c.className),
        hidden:Array.from(document.querySelectorAll('.lk-hidden > .card')).map(c=>(c.querySelector('.tag')||{}).textContent||c.className),
        head:Array.from(document.querySelectorAll('#lookupResultBox .calc-warn')).map(w=>w.textContent).join(' | '),
      }));
    };

    // Меламин: антидемпинговая мера установлена в отношении товара из КНР.
    let r=await run('im','Китай','2933610000');
    assert.ok(r.hidden.every(h=>!/Антидемпинг|антидемпинг/.test(h)), 'мера КНР не должна скрываться для Китая');
    assert.ok(await page.evaluate(()=>!!document.querySelector('#lookupCards > .card[data-cty]')), 'карточка со страной осталась видимой');
    r=await run('im','Германия','2933610000');
    assert.ok(await page.evaluate(()=>!document.querySelector('#lookupCards > .card[data-cty]')), 'для Германии страновые карточки убраны');
    assert.match(r.head,/Германия/);

    // Вывоз: ставка ЕТТ и льготы по НДС к нему не относятся.
    r=await run('ex','','8517130000');
    assert.equal(await page.evaluate(()=>document.querySelectorAll('#lookupCards > .card[data-dir="im"]').length),0);
    assert.ok(await page.evaluate(()=>document.querySelectorAll('.lk-hidden > .card[data-dir="im"]').length>0));
    assert.match(r.head,/вывоз/i);

    // Транзит: то же самое, но с основанием из ТК ЕАЭС.
    r=await run('tr','','8517130000');
    assert.equal(await page.evaluate(()=>document.querySelectorAll('#lookupCards > .card[data-dir="im"]').length),0);
    assert.match(r.head,/142/);

    // Ввоз из ЕАЭС: взаимная торговля — тарифных мер нет, запреты остаются.
    r=await run('im','Казахстан','8517130000');
    assert.equal(await page.evaluate(()=>document.querySelectorAll('#lookupCards > .card[data-kind="tariff"]').length),0);
    assert.match(r.head,/Казахстан/);

    // Без страны и при ввозе не скрывается ничего.
    await run('im','','8517130000');
    assert.equal(await page.evaluate(()=>document.querySelectorAll('.lk-hidden').length),0);

    // Поиск по наименованию: список кандидатов кликабелен, и клик обязан
    // остаться в справке — раньше goToCode() уводил в общий поиск ТН ВЭД.
    await page.selectOption('#lookupDir','im');
    await page.fill('#lookupCty','');
    await page.fill('#lookupQuery','смартфон');
    await page.click('#pageLookup .calc-btn');
    await page.locator('#lookupCards .card').first().waitFor();
    await page.locator('#lookupCards [onclick^="goToCode"]').first().click();
    await page.locator('#lookupCards .card').first().waitFor();
    assert.equal(await page.evaluate(()=>currentPage),'lookup');
    assert.equal(await page.locator('#pageSearch').isVisible(),false);
    assert.match(await page.inputValue('#lookupQuery'),/^\d{4}/);

    // Чипы «Быстрого поиска» в правой колонке видны и на странице справки —
    // из неё они тоже должны работать внутри справки.
    await page.locator('#sg1 button').first().click();
    await page.locator('#lookupCards .card').first().waitFor();
    assert.equal(await page.evaluate(()=>currentPage),'lookup');
    assert.equal(await page.locator('#pageSearch').isVisible(),false);

    // Уход на другую страницу и возврат не стирают уже полученную справку.
    await page.click('#navTreeBtn');
    await page.click('#navLookupBtn');
    assert.equal(await page.inputValue('#lookupDir'),'im');
    assert.ok(await page.evaluate(()=>document.querySelectorAll('#lookupCards > .card').length>0));

    await page.click('#navSearchBtn');
    await page.locator('#sg1 button').first().click();
    await page.locator('#result .card').first().waitFor();
    assert.equal(await page.evaluate(()=>currentPage),'search');

    // Ставка для ОАЭ в карточке ЕТТ: до 06.10.2026 — ЕТТ и дата, с 06.10.2026 — 13,1%
    await page.click('#navLookupBtn');
    await page.selectOption('#lookupDir','im');
    await page.fill('#lookupCty','ОАЭ');
    await page.fill('#lookupQuery','0201100001');
    await page.fill('#lookupDate','2026-09-16');
    await page.click('#pageLookup .calc-btn');
    await page.locator('#lookupCards .pref-rate').first().waitFor();
    assert.match(await page.locator('#lookupCards .pref-rate').first().innerText(),/06\.10\.2026[\s\S]*13,1%/);
    await page.fill('#lookupDate','2026-10-06');
    await page.click('#pageLookup .calc-btn');
    await page.locator('#lookupCards .ett-was').first().waitFor();
    assert.match(await page.locator('#lookupCards .ett-rate').first().innerText(),/15%\s*13,1%/);

    assert.deepEqual(errors,[]);
    console.log('PASS: браузер — порядок полей, три направления, страна происхождения, ЕАЭС');
  }finally{
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
