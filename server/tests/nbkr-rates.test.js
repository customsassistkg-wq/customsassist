// node server/tests/nbkr-rates.test.js
// Запасной курс на диске (services/nbkrRates.js, 02.10.2026): удачный ответ НБКР пишется в server/var/nbkr-rates.json (здесь —
// во временный каталог); после «перезапуска» при недоступном nbkr.kg берётся курс с диска, с датой НБКР и пометкой fromDisk;
// возвращение сайта заменяет его свежим; битый, чужой версии и неполный файл не принимаются; без файла и без сайта — null,
// как раньше. Сеть подменена: https.get отдаёт заданный XML или ошибку.
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
const fresh = () => { delete require.cache[require.resolve('../src/services/nbkrRates')]; return require('../src/services/nbkrRates'); };
const quiet = { log: console.log, warn: console.warn, error: console.error };
const mute = () => { console.warn = console.error = () => {}; };
const unmute = () => { console.warn = quiet.warn; console.error = quiet.error; };

(async () => {
  try {
    // 1. Удача: курс в памяти и файл на диске.
    let svc = fresh();
    let r = await svc.getRates();
    assert.deepEqual([r.date, r.usd, r.eur, r.rates.CNY], ['01.10.2026', 87.45, 100.9086, 12.3]);
    assert.equal(svc.status().fromDisk, false);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual([saved.v, saved.date, saved.usd, saved.eur, saved.rates.KZT], [1, '01.10.2026', 87.45, 100.9086, 0.17]);
    assert.match(saved.savedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.existsSync(file + '.tmp'), false, 'временный файл переименован');

    // 2. «Перезапуск» при недоступном сайте: курс с диска, дата прежняя, ошибка видна, fromDisk.
    mode = 'down'; mute();
    svc = fresh();
    r = await svc.getRates();
    unmute();
    assert.deepEqual([r.date, r.usd, r.eur], ['01.10.2026', 87.45, 100.9086]);
    let st = svc.status();
    assert.deepEqual([st.fromDisk, st.usd, st.date, /ENOTFOUND/.test(st.lastError.message)], [true, 87.45, '01.10.2026', true]);
    // Следующие запросы — из памяти, сеть не дёргается (иначе каждый вопрос ждал бы таймаута).
    const before = calls;
    await svc.getRates(); await svc.getRates();
    assert.equal(calls, before, 'курс в памяти — без новых запросов');

    // 3. Сайт вернулся: следующее обновление заменяет курс свежим и перезаписывает файл.
    mode = 'ok'; body = xml('02.10.2026', '87,60', '101,2');
    await svc.refresh();
    r = await svc.getRates();
    assert.deepEqual([r.date, r.usd, r.eur], ['02.10.2026', 87.6, 101.2]);
    st = svc.status();
    assert.deepEqual([st.fromDisk, st.lastError], [false, null]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).date, '02.10.2026');

    // 4. Ответ сайта 500 при пустой памяти — тоже запасной курс (теперь от 02.10).
    mode = 'http500'; mute();
    svc = fresh();
    r = await svc.getRates();
    unmute();
    assert.deepEqual([r.date, r.usd, svc.status().fromDisk], ['02.10.2026', 87.6, true]);

    // 5. Файл негодный — не принимается; без файла и без сайта курса нет, как до этой правки.
    for (const bad of ['{ не json', JSON.stringify({ v: 2, usd: 1, eur: 1, rates: { USD: 1, EUR: 1 } }),
      JSON.stringify({ v: 1, date: '02.10.2026', usd: 87.6, eur: 101.2, rates: { USD: 87.6 } }),
      JSON.stringify({ v: 1, date: '02.10.2026', usd: -1, eur: 101.2, rates: { USD: -1, EUR: 101.2 } }),
      JSON.stringify({ v: 1, date: '02.10.2026', usd: '87,6', eur: 101.2, rates: { USD: '87,6', EUR: 101.2 } })]) {
      fs.writeFileSync(file, bad);
      mute(); svc = fresh(); r = await svc.getRates(); unmute();
      assert.equal(r, null, 'негодный файл: ' + bad.slice(0, 40));
      assert.equal(svc.status().fromDisk, false);
    }
    fs.rmSync(file);
    mute(); svc = fresh(); r = await svc.getRates(); unmute();
    assert.equal(r, null);

    // 6. Лишние валюты в файле отбрасываются, нужные остаются.
    fs.writeFileSync(file, JSON.stringify({ v: 1, date: '02.10.2026', usd: 87.6, eur: 101.2, rates: { USD: 87.6, EUR: 101.2, CNY: 12.4, XXX: 5 } }));
    mute(); svc = fresh(); r = await svc.getRates(); unmute();
    assert.deepEqual(Object.keys(r.rates).sort(), ['CNY', 'EUR', 'USD']);
    console.log('PASS: запасной курс НБКР — запись при удаче, чтение при недоступном сайте и при ответе 500, замена свежим, негодный файл не принимается');
  } finally {
    unmute();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { unmute(); console.error(e); process.exit(1); });
