// node server/tests/redact.test.js
// Персональные данные не уходят в модель (services/assistant.js, redactPersonal):
// вычищается то, что помечено или однозначно по форме; остаётся всё, без чего ответ
// и расчёт развалятся — код ТН ВЭД, суммы, вес, валюта, страна, номер и дата документа.
// Без сети: чистая функция и один проход ask() с подменённым fetch, чтобы убедиться,
// что до запроса к модели доходит уже очищенный текст.
const assert = require('node:assert/strict');
process.env.AI_API_KEY = 'test';
const nbkr = require('../src/services/nbkrRates');
nbkr.getRates = async () => ({ date: '16.09.2026', usd: 87.45, eur: 100.9086, rates: { USD: 87.45, EUR: 100.9086 } });
const { ask, redactPersonal } = require('../src/services/assistant');

(async () => {
  // ── что вырезается ──
  const gone = [
    ['Почта продавца: ivanov.petr@example.kg, ответьте', /example\.kg|ivanov/i, '[почта]'],
    ['Контакт +996 555 123 456 по грузу', /\+996|555 123/, '[телефон]'],
    ['Тел.: 0700123456', /0700123456/, '[телефон]'],
    ['Оплата картой 4276 3800 1234 5678', /4276|5678/, '[карта]'],
    ['ИНН 12345678901234, плательщик', /12345678901234/, '[идентификатор]'],
    ['IBAN: KG820012345678901234', /KG8200|12345678901234/, '[счёт]'],
    ['Паспорт AN2345678 выдан', /AN2345678/, '[документ]'],
    ['Адрес: г. Бишкек, ул. Киевская, д. 12, кв. 5', /Киевская|кв\. 5/, '[адрес]'],
    ['Грузополучатель: ОсОО «Азия Транс», Бишкек', /Азия Транс/, '[сторона]'],
    ['Consignee: Asia Trans LLC, Bishkek', /Asia Trans/, '[сторона]'],
    ['Подпись: Иванов И.И.', /Иванов/, '[сторона]'],
    ['Декларант Сыдыков А. Б. сообщил', /Сыдыков/, '[сторона]'],
    ['Отгрузку принял Сыдыков А. Б., склад 3', /Сыдыков/, '[ФИО]'],
    ['Груз принял А.Б. Сыдыков в четверг', /Сыдыков/, '[ФИО]'],
  ];
  for (const [src, mustGo, mustStay] of gone) {
    const out = redactPersonal(src);
    assert.ok(!mustGo.test(out), `не вырезано: ${src} → ${out}`);
    assert.ok(out.includes(mustStay), `нет пометки ${mustStay}: ${src} → ${out}`);
  }
  console.log('PASS: почта, телефон, карта, ИНН, счёт, паспорт, адрес, стороны и ФИО заменяются пометками');

  // ── что обязано остаться: без этого нет ни классификации, ни расчёта ──
  const keep = 'Инвойс № INV-2026/0917 от 17.09.2026, условия FOB Shanghai. Товар: смартфоны Redmi Note 13, '
    + 'код ТН ВЭД 8517130000, страна происхождения Китай, 1 000 шт, вес нетто 180,5 кг, брутто 210 кг, '
    + 'стоимость 12 500,00 USD по курсу 87,45 сом, фрахт 800 USD, НДС 12%, VIN JN1TANT31U0012345.';
  const kept = redactPersonal(keep);
  assert.equal(kept, keep, `изменено нужное:\n${keep}\n${kept}`);
  for (const must of ['8517130000', '12 500,00 USD', '180,5 кг', 'Китай', 'FOB Shanghai', 'INV-2026/0917', 'JN1TANT31U0012345'])
    assert.ok(kept.includes(must), `потеряно: ${must}`);
  console.log('PASS: код, суммы, валюта, вес, страна, Инкотермс, номер инвойса и VIN не тронуты');

  // ── строка расшифровки: сторона вырезана, но код и сумма на той же строке остались ──
  const row = redactPersonal('| Грузополучатель: ОсОО «Азия Транс» | 7304190000 | 5 000,00 USD |');
  assert.ok(!row.includes('Азия Транс') && row.includes('[сторона]'), row);
  for (const must of ['7304190000', '5 000,00 USD']) assert.ok(row.includes(must), `потеряно в строке таблицы: ${must}`);
  assert.ok(!/\](?=\S)/.test(redactPersonal('Seller: Shenzhen Co, 8517130000 — 12 500,00 USD')), 'пометка слиплась со следующим словом');
  console.log('PASS: в строке таблицы вырезана только сторона — код, сумма и разделители целы');

  // ── ask(): до модели доходит уже очищенный текст вопроса и документа ──
  const sent = [];
  global.fetch = async (url, opts) => {
    sent.push(opts.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Ответ по коду 8517130000.' }], usage: { input_tokens: 10, output_tokens: 5 } }) };
  };
  await ask([{ role: 'user', content: 'Мой телефон +996 700 111 222, посчитай 8517130000 на 12 500 USD' }],
    { docs: [{ name: 'invoice.pdf', text: 'Seller: Shenzhen Tech Co.\nИНН 12345678901234\nsales@shenzhen.example\n8517130000 — 12 500,00 USD' }] });
  const body = sent.join('\n');
  for (const secret of ['+996 700 111 222', '12345678901234', 'sales@shenzhen.example', 'Shenzhen Tech Co'])
    assert.ok(!body.includes(secret), `ушло в модель: ${secret}`);
  for (const must of ['8517130000', '12 500,00 USD', '[телефон]', '[идентификатор]', '[почта]', '[сторона]'])
    assert.ok(body.includes(must), `не дошло до модели: ${must}`);
  console.log('PASS: ask() отправляет очищенные вопрос и документ, код и сумма на месте');
})().catch((e) => { console.error(e); process.exitCode = 1; });
