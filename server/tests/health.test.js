// node server/tests/health.test.js
// Тихие поломки (services/health.js, 02.10.2026): диск, ночная копия базы, сертификат сайта, курс НБКР — пороги, одно сообщение
// в сутки на беду, «снова в порядке», сбой одной проверки не гасит остальные, в сообщениях нет данных пользователей.
// Источники сведений и Telegram подменены; время задаётся числом.
const assert = require('node:assert/strict');

const telegram = require('../src/services/telegram');
const nbkr = require('../src/services/nbkrRates');
const sent = [];
telegram.notify = (m) => { sent.push(m); };
const fresh = () => { delete require.cache[require.resolve('../src/services/health')]; return require('../src/services/health'); };

const HOUR = 3600e3, DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-02T12:00:00Z');
let T = NOW; // «сейчас» для здоровой машины: копия всегда сделана за восемь часов до него
const at = (ms) => { T = ms; return ms; };
const iso = (ms) => new Date(ms).toISOString();
const GB = 1073741824;
// Здоровая машина: свободно 31 из 38 ГБ, копия сегодня ночью, таймер идёт, сертификат ещё 80 дней, курс обновляется.
const healthy = () => ({
  systemSection: async () => ({ disk: { total: 38 * GB, free: 31 * GB } }),
  systemdSection: async () => ({ backup: { result: 'success', exitStatus: '0', lastExit: iso(T - 8 * HOUR) }, timer: { active: 'active' } }),
  certsSection: async () => [{ host: 'customsassist.trade', daysLeft: 80, validTo: iso(NOW + 80 * DAY) }, { host: 'dash.customsassist.trade', daysLeft: 80, validTo: iso(NOW + 80 * DAY) }],
});
const rates = (over = {}) => { nbkr.status = () => ({ date: '02.10.2026', usd: 87.6, eur: 101.2, updatedAt: iso(NOW - HOUR), lastError: null, fromDisk: false, failingSince: null, ...over }); };
const keys = (list) => list.map((i) => i.key).sort();

(async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    rates();
    const h = fresh();
    // Здоровая машина — тишина.
    assert.deepEqual(await h.issues(NOW, healthy()), []);

    // Диск: меньше 12 % свободного — беда, 15 % — нет.
    let d = healthy(); d.systemSection = async () => ({ disk: { total: 38 * GB, free: 3 * GB } });
    let list = await h.issues(NOW, d);
    assert.deepEqual(keys(list), ['disk']);
    assert.match(list[0].text, /Свободно 8 % — 3,0 ГБ из 38,0 ГБ/);
    d.systemSection = async () => ({ disk: { total: 38 * GB, free: 6 * GB } });
    assert.deepEqual(await h.issues(NOW, d), []);
    d.systemSection = async () => ({ disk: null });
    assert.deepEqual(await h.issues(NOW, d), [], 'диск не определён — не тревога');

    // Копия базы: ошибка последнего запуска, старше 36 часов, выключенный таймер; нет systemd (не Linux) — молчим.
    d = healthy(); d.systemdSection = async () => ({ backup: { result: 'exit-code', exitStatus: '1', lastExit: iso(NOW - HOUR) }, timer: { active: 'active' } });
    list = await h.issues(NOW, d);
    assert.deepEqual(keys(list), ['backup']);
    assert.match(list[0].text, /«exit-code» \(код 1\)/);
    d.systemdSection = async () => ({ backup: { result: 'success', exitStatus: '0', lastExit: iso(NOW - 40 * HOUR) }, timer: { active: 'active' } });
    list = await h.issues(NOW, d);
    assert.deepEqual(keys(list), ['backup-old']);
    assert.match(list[0].text, /40 ч назад/);
    d.systemdSection = async () => ({ backup: { result: 'success', exitStatus: '0', lastExit: iso(NOW - 35 * HOUR) }, timer: { active: 'active' } });
    assert.deepEqual(await h.issues(NOW, d), []);
    d.systemdSection = async () => ({ backup: { result: 'success', exitStatus: '0', lastExit: iso(NOW - HOUR) }, timer: { active: 'inactive' } });
    assert.deepEqual(keys(await h.issues(NOW, d)), ['backup-timer']);
    d.systemdSection = async () => null;
    assert.deepEqual(await h.issues(NOW, d), []);

    // Сертификат: меньше 14 дней — беда (по имени), ошибка соединения без срока — не тревога этой проверки.
    d = healthy(); d.certsSection = async () => [{ host: 'customsassist.trade', daysLeft: 10, validTo: iso(NOW + 10 * DAY) }, { host: 'dash.customsassist.trade', error: 'timeout' }];
    list = await h.issues(NOW, d);
    assert.deepEqual(keys(list), ['cert:customsassist.trade']);
    assert.match(list[0].text, /ещё 10 дн\. \(до 2026-10-12\)/);
    d.certsSection = async () => [{ host: 'customsassist.trade', daysLeft: 14, validTo: iso(NOW + 14 * DAY) }];
    assert.deepEqual(await h.issues(NOW, d), []);

    // Курс НБКР: больше суток подряд — беда, десять часов — нет; запасной курс с диска сам по себе не тревога.
    rates({ failingSince: iso(NOW - 30 * HOUR), lastError: { at: iso(NOW - HOUR), message: 'getaddrinfo ENOTFOUND www.nbkr.kg' }, fromDisk: true, date: '01.10.2026' });
    list = await h.issues(NOW, healthy());
    assert.deepEqual(keys(list), ['rates']);
    assert.match(list[0].text, /30 ч подряд \(getaddrinfo ENOTFOUND www\.nbkr\.kg\).*курсу от 01\.10\.2026 из файла на диске/);
    rates({ failingSince: iso(NOW - 10 * HOUR), lastError: { at: iso(NOW - HOUR), message: 'timeout' }, fromDisk: true });
    assert.deepEqual(await h.issues(NOW, healthy()), []);
    rates();

    // Сбой одной проверки не гасит остальные.
    d = healthy(); d.systemSection = async () => { throw new Error('statfs'); }; d.certsSection = async () => [{ host: 'x.kg', daysLeft: 3, validTo: iso(NOW + 3 * DAY) }];
    assert.deepEqual(keys(await h.issues(NOW, d)), ['cert:x.kg']);

    // run(): одно сообщение в сутки на беду, повтор через сутки, «снова в порядке» один раз.
    const r = fresh();
    sent.length = 0;
    d = healthy(); d.systemSection = async () => ({ disk: { total: 38 * GB, free: 2 * GB } });
    await r.run(at(NOW), d);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^⚠️ <b>Диск сервера почти заполнен<\/b>\nСвободно 5 %/);
    await r.run(at(NOW + 2 * HOUR), d); await r.run(at(NOW + 23 * HOUR), d);
    assert.equal(sent.length, 1, 'в течение суток — молчим');
    await r.run(at(NOW + 25 * HOUR), d);
    assert.equal(sent.length, 2, 'через сутки напоминаем');
    await r.run(at(NOW + 26 * HOUR), healthy());
    assert.equal(sent.length, 3);
    assert.equal(sent[2], '✅ Снова в порядке: Диск сервера почти заполнен');
    await r.run(at(NOW + 27 * HOUR), healthy());
    assert.equal(sent.length, 3, 'о выздоровлении — один раз');
    // Две беды — два сообщения; одна ушла — одно «снова в порядке».
    d = healthy(); d.systemSection = async () => ({ disk: { total: 38 * GB, free: 1 * GB } }); d.certsSection = async () => [{ host: 'customsassist.trade', daysLeft: 5, validTo: iso(NOW + 5 * DAY) }];
    await r.run(at(NOW + 30 * HOUR), d);
    assert.equal(sent.length, 5);
    d.certsSection = async () => [{ host: 'customsassist.trade', daysLeft: 80, validTo: iso(NOW + 80 * DAY) }];
    await r.run(at(NOW + 31 * HOUR), d);
    assert.equal(sent.length, 6);
    assert.equal(sent[5], '✅ Снова в порядке: Сертификат customsassist.trade скоро истекает');
    // В сообщениях нет адресов, имён и ключей.
    assert.ok(sent.every((m) => !/@|sk-|token|password/i.test(m)), sent.join('\n'));
    console.error = quiet;
    console.log('PASS: тихие поломки — пороги диска, копии, сертификата и курса, одно сообщение в сутки, «снова в порядке», сбой одной проверки не гасит остальные');
  } finally {
    console.error = quiet;
  }
})().catch((e) => { console.error(e); process.exit(1); });
