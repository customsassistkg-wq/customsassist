// node server/tests/nbkr-rates.test.js
// Курс НБКР (services/nbkrRates.js, 02.10.2026): (1) запасной курс на диске — удачный ответ пишется в server/var/nbkr-rates.json
// (здесь — во временный каталог), после «перезапуска» при недоступном nbkr.kg берётся курс с диска, с датой НБКР и пометкой fromDisk,
// возвращение сайта заменяет его свежим, негодный файл не принимается; (2) курс на день — НБКР вечером публикует курс на завтра
// (02.10 в 17:40 по Бишкеку daily.xml нёс 03.10), а таможня берёт курс на день регистрации, поэтому getRates() отдаёт курс с
// наибольшей датой не позже сегодняшней по Бишкеку, история из десяти курсов переживает перезапуск. Сеть и часы подменены.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-nbkr-'));
process.env.OPS_STATE_DIR = dir;
const file = path.join(dir, 'nbkr-rates.json');

const xml = (date, usd, eur) => `<?xml version="1.0" encoding="windows-1251"?><CurrencyRates Name="Daily Exchange Rates" Date="${date}">`
  + [['USD', usd], ['EUR', eur], ['CNY', '12,3'], ['RUB', '1,07'], ['KZT', '0,17']].map(([c, v]) => `<Currency ISOCode="${c}"><Nominal>1</Nominal><Value>${v}</Value></Currency>`).join('')
  + '</CurrencyRates>';

let mode = 'ok', body = xml('01.10.2026', '87,45', '100,9086'), calls = 0;
https.get = (url, opts, cb) => {
  calls++;
  const req = new EventEmitter();
  req.destroy = (e) => req.emit('error', e);
  setImmediate(() => {
    if (mode === 'down') return req.emit('error', new Error('getaddrinfo ENOTFOUND www.nbkr.kg'));
    if (mode === 'http500') { const res = new EventEmitter(); res.statusCode = 500; res.resume = () => {}; return cb(res); }
    const res = new EventEmitter(); res.statusCode = 200; res.resume = () => {};
    cb(res);
    setImmediate(() => { res.emit('data', Buffer.from(body, 'latin1')); res.emit('end'); });
  });
  return req;
};
// Часы: момент задаётся числом (UTC); Бишкек = UTC+6.
const realNow = Date.now;
let clock = Date.parse('2026-10-02T06:00:00Z'); // 12:00 по Бишкеку, 02.10
Date.now = () => clock;
const fresh = () => { delete require.cache[require.resolve('../src/services/nbkrRates')]; return require('../src/services/nbkrRates'); };
const quiet = { log: console.log, warn: console.warn, error: console.error };
const mute = () => { console.warn = console.error = () => {}; };
const unmute = () => { console.warn = quiet.warn; console.error = quiet.error; };
const feed = async (svc, date, usd, eur) => { mode = 'ok'; body = xml(date, usd, eur); await svc.refresh(); };

(async () => {
  try {
    // 1. Удача: курс в памяти и файл на диске.
    let svc = fresh();
    let r = await svc.getRates();
    assert.deepEqual([r.date, r.usd, r.eur, r.rates.CNY], ['01.10.2026', 87.45, 100.9086, 12.3]);
    assert.equal(svc.status().fromDisk, false);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual([saved.v, saved.date, saved.usd, saved.eur, saved.rates.KZT, saved.history.length], [2, '01.10.2026', 87.45, 100.9086, 0.17, 1]);
    assert.match(saved.savedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.existsSync(file + '.tmp'), false, 'временный файл переименован');
    assert.equal('history' in r, false, 'в ответ службы история не попадает');

    // 2. «Перезапуск» при недоступном сайте: курс с диска, дата прежняя, ошибка видна, fromDisk.
    mode = 'down'; mute();
    svc = fresh();
    r = await svc.getRates();
    unmute();
    assert.deepEqual([r.date, r.usd, r.eur], ['01.10.2026', 87.45, 100.9086]);
    let st = svc.status();
    assert.deepEqual([st.fromDisk, st.usd, st.date, /ENOTFOUND/.test(st.lastError.message)], [true, 87.45, '01.10.2026', true]);
    assert.ok(st.failingSince, 'с какого момента запросы не удаются');
    const before = calls;
    await svc.getRates(); await svc.getRates();
    assert.equal(calls, before, 'курс в памяти — без новых запросов');

    // 3. Сайт вернулся: следующее обновление заменяет курс свежим и перезаписывает файл; failingSince сброшен.
    await feed(svc, '02.10.2026', '87,60', '101,2');
    r = await svc.getRates();
    assert.deepEqual([r.date, r.usd, r.eur], ['02.10.2026', 87.6, 101.2]);
    st = svc.status();
    assert.deepEqual([st.fromDisk, st.lastError, st.failingSince], [false, null, null]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).date, '02.10.2026');

    // 4. Ответ сайта 500 при пустой памяти — тоже запасной курс (теперь от 02.10).
    mode = 'http500'; mute();
    svc = fresh();
    r = await svc.getRates();
    unmute();
    assert.deepEqual([r.date, r.usd, svc.status().fromDisk], ['02.10.2026', 87.6, true]);

    // 5. Файл негодный — не принимается; без файла и без сайта курса нет.
    for (const bad of ['{ не json', JSON.stringify({ v: 3, usd: 1, eur: 1, rates: { USD: 1, EUR: 1 } }),
      JSON.stringify({ v: 1, date: '02.10.2026', usd: 87.6, eur: 101.2, rates: { USD: 87.6 } }),
      JSON.stringify({ v: 2, date: '02.10.2026', usd: -1, eur: 101.2, rates: { USD: -1, EUR: 101.2 }, history: [] }),
      JSON.stringify({ v: 1, date: '02.10.2026', usd: '87,6', eur: 101.2, rates: { USD: '87,6', EUR: 101.2 } })]) {
      fs.writeFileSync(file, bad);
      mute(); svc = fresh(); r = await svc.getRates(); unmute();
      assert.equal(r, null, 'негодный файл: ' + bad.slice(0, 40));
      assert.equal(svc.status().fromDisk, false);
    }
    fs.rmSync(file);
    mute(); svc = fresh(); r = await svc.getRates(); unmute();
    assert.equal(r, null);
    // Старый файл (версия 1, без истории) читается; лишние валюты отбрасываются.
    fs.writeFileSync(file, JSON.stringify({ v: 1, date: '02.10.2026', usd: 87.6, eur: 101.2, rates: { USD: 87.6, EUR: 101.2, CNY: 12.4, XXX: 5 } }));
    mute(); svc = fresh(); r = await svc.getRates(); unmute();
    assert.deepEqual([r.date, Object.keys(r.rates).sort()], ['02.10.2026', ['CNY', 'EUR', 'USD']]);
    console.log('PASS: запасной курс НБКР — запись при удаче, чтение при недоступном сайте и при ответе 500, замена свежим, негодный файл не принимается, файл версии 1 читается');

    // 6. Курс на день. НБКР вечером 01.10 опубликовал курс на 02.10, вечером 02.10 — на 03.10.
    fs.rmSync(file, { force: true });
    clock = Date.parse('2026-10-01T12:30:00Z'); // 18:30 по Бишкеку, 01.10
    svc = fresh();
    await feed(svc, '01.10.2026', '87,40', '100,0');   // курс на сегодня, 01.10
    await feed(svc, '02.10.2026', '87,45', '100,5');   // вечером пришёл курс на завтра
    assert.equal((await svc.getRates()).date, '01.10.2026', 'вечером 01.10 — курс на 01.10, а не на завтра');
    clock = Date.parse('2026-10-01T18:05:00Z');         // 00:05 по Бишкеку, 02.10 — полночь прошла без нового запроса
    assert.equal((await svc.getRates()).date, '02.10.2026', 'после полуночи — курс на 02.10');
    clock = Date.parse('2026-10-02T11:40:00Z');         // 17:40 по Бишкеку, 02.10: пришёл курс на 03.10
    await feed(svc, '03.10.2026', '87,50', '98,3813');
    r = await svc.getRates();
    assert.deepEqual([r.date, r.usd, r.eur], ['02.10.2026', 87.45, 100.5], 'вечером 02.10 — курс на 02.10, не завтрашний');
    st = svc.status();
    assert.deepEqual([st.date, st.effectiveDate], ['03.10.2026', '02.10.2026'], 'последний полученный и действующий различаются');
    assert.equal((await svc.getRates('2026-10-03')).date, '03.10.2026', 'явный день');
    assert.equal((await svc.getRates('2026-10-01')).date, '01.10.2026');
    assert.equal((await svc.getRates('2026-09-01')).date, '01.10.2026', 'до самого раннего — самый ранний, а не отказ');
    clock = Date.parse('2026-10-02T18:30:00Z');         // 00:30 по Бишкеку, 03.10
    assert.equal((await svc.getRates()).date, '03.10.2026');

    // 7. История переживает перезапуск: сайт недоступен, а выбор по дню работает по файлу.
    clock = Date.parse('2026-10-02T11:50:00Z');
    mode = 'down'; mute();
    svc = fresh();
    r = await svc.getRates();
    unmute();
    assert.equal(r.date, '02.10.2026', 'после перезапуска вечером 02.10 с диска — курс на 02.10');
    assert.equal(svc.status().fromDisk, true);
    assert.equal((await svc.getRates('2026-10-03')).date, '03.10.2026');

    // 8. Первый запуск вечером, вчерашнего курса нет: отдаётся имеющийся (на завтра), а не отказ.
    fs.rmSync(file, { force: true });
    clock = Date.parse('2026-10-02T11:40:00Z');
    svc = fresh();
    await feed(svc, '03.10.2026', '87,50', '98,3813');
    assert.equal((await svc.getRates()).date, '03.10.2026');

    // 9. Один и тот же день дважды — заменяется, а не дублируется; в истории не больше десяти курсов, остаются последние.
    await feed(svc, '03.10.2026', '87,55', '98,4');
    assert.equal((await svc.getRates()).usd, 87.55);
    for (let d = 4; d <= 15; d++) await feed(svc, String(d).padStart(2, '0') + '.10.2026', '87,6', '98,5');
    const hist = JSON.parse(fs.readFileSync(file, 'utf8')).history.map((h) => h.date);
    assert.equal(hist.length, 10);
    assert.deepEqual([hist[0], hist[9]], ['06.10.2026', '15.10.2026']);
    assert.equal(new Set(hist).size, 10);
    console.log('PASS: курс на день — вечером до полуночи курс текущего дня, а не завтрашний; явный день; история из десяти курсов в файле переживает перезапуск; одно и то же число заменяется');
  } finally {
    Date.now = realNow;
    unmute();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { Date.now = realNow; unmute(); console.error(e); process.exit(1); });
