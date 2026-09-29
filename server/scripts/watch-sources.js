// Дозор источников: что появилось у государства, чего ещё нет в базе, и что в базе
// вот-вот истечёт. Семь официальных источников и проверка самой базы:
//
//  1. Сайт Кабинета Министров (gov.kg/ru/npa/c/provisions) — постановления с датой
//     официального опубликования появляются там через день-два после подписания,
//     задолго до индексации в реестре НПА. Каждый свежий акт открывается, текст
//     проверяется на таможенные слова, и если пары «№ N от ДД.ММ.ГГГГ» нет в base.js —
//     это находка.
//  2. Реестр НПА (cbd.minjust.gov.kg, GetDocuments по дате принятия) — те же
//     постановления Кабмина, когда реестр их проиндексирует, плюс ссылка-карточка.
//  3. Счётчик квоты ГТС на customs.gov.kg (беспошлинные электромобили) — цифры в
//     карточке льготы статичны; если счётчик ушёл от них, карточку пора править.
//
//  4. ЕС НСИ ЕАЭС (nsi.eaeunion.org) — справочники, по которым сверяется база
//     (NSI_WATCH): если дата обновления справочника новее той, по которой его сверяли,
//     это находка до тех пор, пока после сверки дату в NSI_WATCH не поднимут.
//
//  5. Реестр мер защиты внутреннего рынка ЕЭК (remedies.eaeunion.org) — действующие
//     антидемпинговые, специальные и компенсационные меры против ANTIDUMP_DB (remediesDiff).
//
//  6. ЕТТ ЕАЭС на сайте ЕЭК — файлы глав против private/tnved-notes.json, примечания и список
//     изменяющих решений против ETT_SEEN (ettChanges).
//
//  7. Кыргызские публикации против KG_SEEN: выпуск реестра ТРОИС ГТС, файл ветеринарных
//     ограничений на ввоз (vet.gov.kg), темы ГНС (sti.gov.kg); и законопроекты Жогорку Кенеша
//     по таможне и налогам за окно — как раннее предупреждение.
//
// И восьмое, без сети: датированные меры базы (запреты, льготы, антидемпинг),
// срок которых истёк или истекает в ближайшие дни, возраст UNIMEAS_ASOF и записей
// SOURCE_AUDIT.
//
// Запуск: node scripts/watch-sources.js [--days N] [--mail] [--json]
//   --days  окно по дате опубликования/принятия, по умолчанию 21 день
//   --mail  отправить отчёт активным администраторам (как alert-admins.js)
// Код выхода 1, если есть находки, 2 — если один из источников не ответил.
// На сервере запускает tnved-watch-sources.timer (ежедневно), см. docs/backend-ops.md.
//
// ponytail: ключевые слова и regex по HTML вместо разбора DOM — gov.kg отдаёт простую
// таблицу, реестр — JSON; когда разметка поменяется, тест на fixture это покажет.
require('dotenv').config();
require('node:dns').setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const zlib = require('node:zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const GOV_LIST = 'https://www.gov.kg/ru/npa/c/provisions';
const REG_SEARCH = 'https://cbd.minjust.gov.kg/api/v1/GetDocuments';
const GTS_HOME = 'https://www.customs.gov.kg/site/ru/master/customskg';
const NSI_LIST = 'https://nsi.eaeunion.org/portal/api/registries/get-list-data';
const ETT_PAGE = 'https://eec.eaeunion.org/comission/department/catr/ett/';
// ЕТТ на странице ЕЭК: файлы глав сравниваются с теми, по которым собрана база
// (private/tnved-notes.json, chapters[NN].url); примечания и список «в ред. решений…» — с
// датами, по которым база сверена. Сверил новую редакцию — подними даты здесь.
const ETT_SEEN = { notesEtt: '2026-08-24', notesTnved: '2025-05-11', lastAmend: '2026-08-11' };
// Кыргызские публикации, по которым сверена база. Сверил новый выпуск — подними отметку здесь.
//  trois — имя PDF реестра ТРОИС на странице ГТС (Enonic отдаёт вложения ссылками …/attachment/inline/<id>:<hash>/<имя>.pdf);
//  vet   — дата последнего файла «Ограничения на ввоз» ветеринарной службы (WordPress media API);
//  sti   — темы ГНС (открытый API sti.gov.kg): дата последнего документа, по которому сверена база.
const KG_SEEN = {
  trois: '11 -16 сентября   2026 года ТРОИС ГТС.pdf',
  vet: '2026-08-25',
  sti: {
    'fc8a71a8-13f5-4d35-9ef2-4403bd572759': { what: 'налоговая база НДС с признаками риска (приказ П-347) → карточка НДС-риска', seen: '2026-08-19' },
    '6bd04495-c141-4e8a-be49-a8d384a2d273': { what: 'перечень товаров для прослеживаемости ЕАЭС', seen: '2026-08-28' },
  },
};
const TROIS_PAGE = 'https://www.customs.gov.kg/site/ru/master/customskg/intellektualdyk-menchik-ukuktaryn-korgoo';
const VET_MEDIA = 'https://vet.gov.kg/wp-json/wp/v2/media?search=%D0%BE%D0%B3%D1%80%D0%B0%D0%BD%D0%B8%D1%87%D0%B5%D0%BD&per_page=20&orderby=date&order=desc&_fields=date,source_url,title';
const STI_DOCS = (theme) => `https://sti.gov.kg/api/Documents/get-documents-by-theme-id?themeId=${theme}&language=1&page=1`;
const KENESH_DOCS = 'https://kenesh.kg/sed/docs?page=0&limit=100';
const BILL_RE = /таможен|налог|акциз|лицензи|ЕАЭС|Евразийск|свободной торговл|нетарифн|технического регулирования|ветеринар|фитосанитар/i;
const REMEDIES_FIND = 'https://remedies.eaeunion.org/spd2/find?collection=zvr.v_actionsregistry&limit=5000';
const BASE_PATH = path.join(__dirname, '..', 'private', 'base.js');
// Справочники ЕС НСИ, с которыми сверяется база: код → что в базе от него зависит и дата
// обновления справочника, по которой база последний раз сверена (null — ещё не сверялась).
// Сверил — поставь сюда дату updateDateTime, которую видел, в том же коммите, что и
// SOURCE_AUDIT. № 1999 (классификационные решения) не здесь: его сама забирает
// services/classDecisions.js; № 1995 (СГР) — поиск по товару, меняется ежедневно; № 1067
// («Перечень санитарных мер») — только коды видов мер, без стран и товаров, базе не нужен.
// № 1992 (РЭС и ВЧУ) и № 1994 (нотификации) — карточки разделов 2.16 и 2.19 ссылаются на
// них, а не копируют: обновление реестра базу не устаревает (1994 меняется почти ежедневно).
const NSI_WATCH = {
  1022: { what: 'перечень техрегламентов ЕАЭС → списки ТР в базе', seen: '2024-12-08' },
  2008: { what: 'классификатор льгот по уплате платежей → коды льгот у помощника', seen: '2026-01-29' },
  2010: { what: 'классификатор видов платежей → виды 1010, 2010, 5010 в расчёте помощника', seen: '2026-01-29' },
  2011: { what: 'классификатор особенностей уплаты → «УН» (условное начисление НДС) в базе и у помощника', seen: '2024-12-07' },
};
// gov.kg отдаёт только листовой сертификат без промежуточного RapidSSL TLS RSA CA G1,
// и Node отказывает («unable to verify the first certificate»); промежуточный взят с
// cacerts.digicert.com и лежит рядом — добавляется к системным корням, ничего не отключая.
const EXTRA_CA = fs.readFileSync(path.join(__dirname, '..', 'certs', 'RapidSSLTLSRSACAG1.crt.pem'), 'utf8');

// Слова, по которым акт считается таможенным. Широко нарочно: лучше лишняя строка в
// письме, чем пропущенный запрет.
const TRADE_RE = /запрет|ввоз|вывоз|таможен|ТН ?ВЭД|квот|пошлин|лицензир|акциз|нетарифн|техническ\w* регламент|сертифик|ветеринар|фитосанитар|санитарн|экспорт|импорт/i;

const strip = (html) => String(html)
  .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
  .replace(/\s+/g, ' ').trim();

const isoFromDmy = (d) => d.replace(/^(\d\d)[.-](\d\d)[.-](\d{4})$/, '$3-$2-$1');
const dmyFromIso = (d) => d.replace(/^(\d{4})-(\d\d)-(\d\d)$/, '$3.$2.$1');
const todayIso = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// node:https, а не fetch: нужен свой список CA и family:4 (IPv6 на VPS прописан, но не работает).
// customs.gov.kg время от времени сбрасывает TLS на первом соединении, реестр отвечает 429
// при частых запросах — до трёх попыток с растущей паузой.
async function fetchText(url, init = {}) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(3000 * attempt);
    try { return await fetchOnce(url, init); } catch (err) { last = err; }
  }
  throw last;
}
function fetchOnce(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method, family: 4, timeout: 40000, ca: tls.rootCertificates.concat(EXTRA_CA),
      // gzip обязательно: eec.eaeunion.org отдаёт серверу несжатую страницу ЕТТ по ~250 байт/с
      // (16 КБ за минуту), сжатую — за полсекунды (проверено с VPS 24.09.2026).
      headers: { 'User-Agent': UA, Referer: 'https://cbd.minjust.gov.kg/', Origin: 'https://cbd.minjust.gov.kg', 'Accept-Encoding': 'gzip, deflate', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${url} → HTTP ${res.statusCode}`));
        const raw = Buffer.concat(chunks), enc = String(res.headers['content-encoding'] || '');
        try {
          resolve((enc.includes('gzip') ? zlib.gunzipSync(raw) : enc.includes('deflate') ? zlib.inflateSync(raw) : raw).toString('utf8'));
        } catch (err) { reject(new Error(`${url} → ${err.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${url} → таймаут`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- разбор (чистые функции, покрыты тестом) --------------------------------

// Строки таблицы gov.kg: дата опубликования, номер, ссылка на карточку.
function parseGovList(html) {
  const out = [];
  const re = /<tr>\s*<td>(\d\d-\d\d-\d{4})<\/td>\s*<td>(\d+)<\/td>\s*<td>\s*<a href="([^"]+)">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const title = strip(m[4]);
    const adopted = (title.match(/(\d\d\.\d\d\.\d{4})/) || [])[1] || null;
    out.push({ pub: isoFromDmy(m[1]), num: m[2], url: m[3], title, adopted: adopted ? isoFromDmy(adopted) : null });
  }
  return out;
}

// Текст карточки gov.kg: блок section-npa без меню и подвала.
function parseGovItem(html) {
  const i = html.indexOf('>', html.indexOf('section-npa')) + 1;
  const j = html.indexOf('aside-content', i);
  return strip(html.slice(i, j > i ? j : undefined));
}

// Ответ GetDocuments: только постановления Кабинета Министров.
function parseRegistry(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  return (d.data || [])
    .filter((x) => /^Постановление/.test(x.vid || '') && /Кабинет/.test(x.organ || ''))
    .map((x) => {
      const name = strip(x.nameRu || '');
      const num = (name.match(/№\s*(\d+)/) || [])[1] || null;
      return {
        code: x.documentCode, num, adopted: String(x.dateAdopted || '').slice(0, 10),
        pub: String(x.datePublication || '').slice(0, 10) || null, title: name,
        url: `https://cbd.minjust.gov.kg/${x.documentCode}/edition/${x.lastEdition}/ru`,
      };
    });
}

// Счётчик ГТС: {"values":[{"name":"Квота…","value":25000},{…использовано…},{…остаток…}]}
// На странице несколько виджетов с "values"; нужен тот, где есть слово «квота».
function parseGtsCounter(html) {
  for (const m of String(html).matchAll(/"values":\s*(\[[^\]]*\])/g)) {
    let vals;
    try { vals = JSON.parse(m[1]); } catch { continue; }
    if (!Array.isArray(vals) || !vals.some((v) => /квот/i.test(v.name || ''))) continue;
    return counterOf(vals);
  }
  return null;
}
function counterOf(vals) {
  const pick = (re) => (vals.find((v) => re.test(v.name)) || {}).value;
  // имена на 23.09.2026: «Квоты на электромобили 2026г», «На текущий момент использовано»,
  // «Оставшееся количество квот»
  return { total: pick(/^квот/i), used: pick(/использован/i), left: pick(/остав|остат/i) };
}

// Список справочников ЕС НСИ: у справочника может быть несколько версий — берётся самая
// поздняя из двух дат, updateDateTime и dateTimeFrom (начало действия версии): у № 1022
// обновление 2023 года, а версия действует с 08.12.2024. Возвращает те из `watch`, что
// обновлены после `seen`.
function nsiChanges(list, watch) {
  const latest = {};
  for (const x of list || []) {
    const d = [x.updateDateTime, x.dateTimeFrom].map((v) => String(v || '').slice(0, 10)).sort().pop();
    if (!(String(x.code) in watch) || !d) continue;
    if (!latest[x.code] || d > latest[x.code].date) latest[x.code] = { date: d, title: (x.data && x.data.TitleName) || '' };
  }
  const out = [];
  for (const [code, w] of Object.entries(watch)) {
    const l = latest[code];
    if (!l) out.push({ code, missing: true, what: w.what });
    else if (!w.seen || l.date > w.seen) out.push({ code, date: l.date, seen: w.seen, title: l.title, what: w.what });
  }
  return out;
}

// Страница ЕТТ ЕЭК против базы. Имя файла главы несёт дату вступления редакции в силу
// (ЕЭК выкладывает файл за несколько дней), поэтому новая глава — это новое имя файла.
function ettChanges(html, notesJson, seen, today) {
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const hrefs = [...String(html).matchAll(/href="([^"]+)"/g)].map((m) => dec(m[1]));
  const chapters = {};
  for (const h of hrefs) {
    const m = h.match(/\/ru\.(\d\d)_2022(?:_(\d\d\.\d\d\.\d{4}))?\.pdf$/);
    if (m) chapters[m[1]] = { file: h.split('/').pop(), date: m[2] ? isoFromDmy(m[2]) : null };
  }
  const out = [];
  for (const [c, { file, date }] of Object.entries(chapters)) {
    const used = String(((notesJson.chapters || {})[c] || (notesJson.chapters || {})[+c] || {}).url || '').split('/').pop();
    if (file !== used) out.push(`глава ${c}: ЕЭК публикует ${file}${date && date > today ? ` (вступает ${dmyFromIso(date)})` : ''}, база собрана по ${used || '—'} — сверить коды и ставки ETT_DB, пересобрать tnved-notes/ett-footnotes`);
  }
  const latest = (re) => hrefs.map((h) => (h.match(re) || [])[1]).filter(Boolean).map(isoFromDmy).sort().pop();
  const nE = latest(/Примечания к ЕТТ_(\d\d\.\d\d\.\d{4})\.pdf$/), nT = latest(/Примечания к ТН ВЭД_(\d\d\.\d\d\.\d{4})\.pdf$/);
  if (nE && nE > seen.notesEtt) out.push(`«Примечания к ЕТТ» — новая редакция от ${dmyFromIso(nE)} (база по ${dmyFromIso(seen.notesEtt)}) — пересобрать ett-footnotes.json`);
  if (nT && nT > seen.notesTnved) out.push(`«Примечания к ТН ВЭД» — новая редакция от ${dmyFromIso(nT)} (база по ${dmyFromIso(seen.notesTnved)})`);
  const text = String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const i = text.indexOf('в ред.');
  const pairs = i < 0 ? [] : [...text.slice(i, i + 40000).matchAll(/от (\d\d\.\d\d\.\d{4})\s*(?:г\.\s*)?№\s*(\d+)/g)];
  for (const [, d, n] of pairs) if (isoFromDmy(d) > seen.lastAmend) out.push(`в редакцию ЕТТ внесено решение № ${n} от ${d} — сверить изменённые главы`);
  return { chapters: Object.keys(chapters).length, amendments: pairs.length, changes: out };
}

// Имена PDF реестра ТРОИС на странице ГТС.
function troisFiles(html) {
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  return [...new Set([...String(html).matchAll(/"([^"]*\/attachment\/inline\/[^"]+\.pdf)"/g)].map((m) => dec(m[1]).split('/').pop()))]
    .filter((n) => /ТРОИС/i.test(n));
}

// Законопроекты Жогорку Кенеша, зарегистрированные с `since`, по таможне, налогам и торговле —
// только раннее предупреждение: в базу закон попадает после принятия и опубликования.
function freshBills(list, since) {
  return (list || []).filter((b) => String(b.vh_dat || '').slice(0, 10) >= since && BILL_RE.test(b.zpNameRus || ''))
    .map((b) => ({ n: b.vh_nom, d: String(b.vh_dat).slice(0, 10), title: String(b.zpNameRus || '').replace(/\s+/g, ' ').trim() }));
}

// Реестр мер защиты внутреннего рынка ЕЭК против ANTIDUMP_DB. Мера реестра и строка базы —
// одно и то же, если у них есть общий код (префикс в любую сторону) и один последний день
// действия: страны сравнивать не нужно, а у мер на один код (литые диски КНР и JP/TH/TR/MY,
// электроды КНР и Индии) сроки разные. Возвращает меры реестра без пары в базе и строки
// базы без пары среди действующих мер реестра.
function remediesDiff(register, antidump) {
  const digits = (c) => String(c).replace(/\D/g, '');
  const share = (a, b) => a.some((x) => b.some((y) => x && y && (x.startsWith(y) || y.startsWith(x))));
  const live = (register || []).filter((m) => m.actual).map((m) => ({
    id: m.investigationnumber, name: m.shortname || '', end: String(m.enddate || '').slice(0, 10),
    codes: (m.tnved || []).map(digits), countries: (m.exportingcountrycode || []).join(', '),
  }));
  const rows = (antidump || []).map((r) => ({ codes: (r[0] || []).map(digits), name: r[2], end: r[6] }));
  const pair = (m, r) => m.end === r.end && share(m.codes, r.codes);
  return {
    missing: live.filter((m) => !rows.some((r) => pair(m, r))),
    stale: rows.filter((r) => !live.some((m) => pair(m, r))),
  };
}

// Пары «№ N от ДД.ММ.ГГГГ» и «от ДД.ММ.ГГГГ № N», которые база уже знает: карточки пишут
// и так («Пост. КМ КР №230 от 08.04.2026»), и так («ПКМ КР от 09.09.2026 № 606»).
function knownActs(baseSrc) {
  const set = new Set();
  let m;
  const re1 = /№\s*(\d{1,4})\s*от\s*(\d\d\.\d\d\.20\d\d)/g;
  while ((m = re1.exec(baseSrc))) set.add(`${m[1]}@${isoFromDmy(m[2])}`);
  const re2 = /от\s*(\d\d\.\d\d\.20\d\d)\s*(?:года\s*)?№\s*(\d{1,4})\b/g;
  while ((m = re2.exec(baseSrc))) set.add(`${m[2]}@${isoFromDmy(m[1])}`);
  return set;
}

// Цифры счётчика, записанные в карточке льготы.
function baseCounter(baseSrc) {
  const m = baseSrc.match(/использовано\s+([\d\s ]+?)\s+из\s+([\d\s ]+?)\s+штук,\s+остаток\s+(\d+)/);
  if (!m) return null;
  const n = (s) => Number(String(s).replace(/\D/g, ''));
  return { used: n(m[1]), total: n(m[2]), left: n(m[3]) };
}

// Датированные меры базы: что истекает в ближайшие `horizon` дней или истекло не дольше
// `grace` дней назад (дольше — уже открытый вопрос в CURRENT.md, а не новость для письма).
// Истёкшая мера, продление которой уже искали (в карточке «продление … не найдено»), не
// повторяется в каждом письме: постановление о продлении придёт находкой gov.kg или реестра.
function datedMeasures(base, today, horizon = 14, grace = 30) {
  const out = [];
  const add = (label, date, note, reviewed) => {
    if (!date) return;
    const left = daysBetween(today, date);
    if (left < 0 && reviewed) return;
    if (left <= horizon && left >= -grace) out.push({ label, date, left, note });
  };
  const reviewed = (n) => /продлен[^·]*не найден/.test(n || '');
  for (const e of base.BAN_DB || []) {
    const name = (e.name || '').slice(0, 90);
    add(`запрет ввоза: ${name}`, e.imUntil, e.imN && /продлен|истёк/.test(e.imN) ? '' : 'проверить продление', reviewed(e.imN));
    add(`запрет вывоза: ${name}`, e.exUntil, e.exN && /продлен|истёк/.test(e.exN) ? '' : 'проверить продление', reviewed(e.exN));
    add(`льгота: ${name}`, e['льгUntil'], '');
  }
  for (const r of base.ANTIDUMP_DB || []) add(`антидемпинг: ${String(r[2] || '').slice(0, 90)} (${r[1] || ''})`, r[6], '');
  // Приостановленная преференция ЗСТ («с … по ДД.ММ.ГГГГ … временно не действует»).
  for (const p of base.PREF_FTA || []) {
    const m = String(p.w || '').match(/по (\d\d\.\d\d\.\d{4})/);
    if (m) add(`преференция ЗСТ (${p.n}) приостановлена`, isoFromDmy(m[1]), 'проверить продление триггерной меры');
  }
  return out.sort((a, b) => a.left - b.left);
}

// Слепые пятна датированных данных, которых нет в полях сроков:
//  - запрет, в тексте которого срок «с ДД.ММ.ГГГГ до ДД.ММ.ГГГГ» есть, а поля imUntil/exUntil нет —
//    карточка никогда не покажет его истёкшим, а datedMeasures его не видит;
//  - тарифная квота, у которой с октября нет строки на следующий год.
function dataGaps(base, today) {
  const out = [];
  for (const e of base.BAN_DB || []) {
    for (const side of ['im', 'ex']) {
      const m = e[side] && !e[side + 'Until'] && String(e[side + 'N'] || '').match(/с (\d\d\.\d\d\.\d{4}) до (\d\d\.\d\d\.\d{4})/);
      if (m) out.push(`запрет ${side === 'im' ? 'ввоза' : 'вывоза'}: ${String(e.name || '').slice(0, 80)} — в тексте срок с ${m[1]} до ${m[2]}, а поля ${side}From/${side}Until нет`);
    }
  }
  // Запрет в BAN_DB и запись реестра односторонних мер (UNIMEAS_DB) по одному постановлению
  // с разным концом срока. Сравниваются только действующие записи реестра: у прежних актов на тот
  // же товар (карточка упоминает их в истории) свой, уже прошедший срок. Если карточка или
  // запись сверки называет дату реестра (разобранная ошибка реестра, как у гипсокартона № 230),
  // расхождение считается известным.
  const audits = JSON.stringify(base.SOURCE_AUDIT || {});
  for (const u of base.UNIMEAS_DB || []) {
    // номера постановлений повторяются из года в год — акт узнаётся по номеру и дате принятия
    const [, adopted, num] = String(u[11] || '').match(/от (\d\d\.\d\d\.\d{4})\s*№\s*(\d+)/) || [];
    const end = (String(u[10] || '').match(/(?:до|по) (\d\d\.\d\d\.\d{4})/) || [])[1];
    if (!num || !end || /прекращ/.test(u[10]) || isoFromDmy(end) < today || audits.includes(end)) continue;
    const side = /ввоз/i.test(u[3]) ? 'im' : /вывоз/i.test(u[3]) ? 'ex' : null;
    if (!side) continue;
    const re = new RegExp(`№\\s*${num}(?!\\d)`);
    for (const e of base.BAN_DB || []) {
      const until = e[side + 'Until'];
      const txt = String(e[side + 'N'] || '');
      if (!until || !re.test(txt) || !txt.includes(adopted) || until === isoFromDmy(end)) continue;
      if (JSON.stringify(e).includes(end)) continue;
      out.push(`${String(e.name || '').slice(0, 60)}: карточка — до ${dmyFromIso(until)}, реестр односторонних мер (№ ${num}) — до ${end}; сверить с текстом постановления`);
    }
  }
  const year = Number(today.slice(0, 4));
  if (today.slice(5) >= '10-01') {
    const last = {};
    for (const q of base.QUOTA_DB || []) {
      const y = Math.max(...String(q[2]).match(/\d{4}/g).map(Number));
      last[q[1]] = Math.max(last[q[1]] || 0, y);
    }
    for (const [name, y] of Object.entries(last)) if (y === year) out.push(`квота «${name.slice(0, 80)}» есть только по ${y} год — решения на ${year + 1} в базе нет`);
  }
  return out;
}

// --- сбор -------------------------------------------------------------------

async function collect({ days = 21, log = () => {} } = {}) {
  const today = todayIso();
  const since = new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);
  const baseSrc = fs.readFileSync(BASE_PATH, 'utf8');
  const known = knownActs(baseSrc);
  const findings = [];
  const errors = [];

  // 1. gov.kg
  try {
    const rows = [];
    for (let page = 1; page <= 3; page++) {
      const html = await fetchText(`${GOV_LIST}?page=${page}`);
      const part = parseGovList(html);
      rows.push(...part);
      if (!part.length || part[part.length - 1].pub < since) break;
    }
    const fresh = rows.filter((r) => r.pub >= since);
    log(`gov.kg: ${rows.length} строк, свежих ${fresh.length}`);
    for (const r of fresh) {
      const text = parseGovItem(await fetchText(r.url));
      const trade = TRADE_RE.test(text);
      const key = r.adopted ? `${r.num}@${r.adopted}` : null;
      const inBase = key ? known.has(key) : false;
      if (trade && !inBase) {
        findings.push({ kind: 'new-act', src: 'gov.kg', text: `ПКМ № ${r.num} от ${r.adopted ? dmyFromIso(r.adopted) : '?'} (опубликовано ${dmyFromIso(r.pub)}), в базе не упомянуто: ${text.slice(0, 220)}… ${r.url}` });
      }
    }
  } catch (err) { errors.push(`gov.kg: ${err.message}`); }

  // 2. реестр НПА — GetDocuments отдаёт не больше 12 записей на запрос, сколько бы их ни
  // было (docs/legal-sources.md), поэтому по одному дню за запрос.
  try {
    const acts = [];
    for (let d = since; d <= today; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) {
      // refTypeId 0050 = «Постановление», authoritiesId 0040.0011 = Кабинет Министров КР —
      // коды классификатора реестра, видны в карточке любого ПКМ (GetDocument); без них в
      // 12 записей дня попадают законы и приказы, а постановления остаются за бортом.
      const body = JSON.stringify({ dateAdoptedFrom: d, dateAdoptedTo: d, refTypeId: '0050', authoritiesId: '0040.0011' });
      if (d !== since) await sleep(1500);
      const parsed = JSON.parse(await fetchText(REG_SEARCH, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }));
      if ((parsed.data || []).length < (parsed.totalResultsCount || 0)) errors.push(`реестр НПА: за ${dmyFromIso(d)} актов ${parsed.totalResultsCount}, получено ${parsed.data.length} — день просмотрен не целиком`);
      acts.push(...parseRegistry(parsed));
    }
    log(`реестр: постановлений Кабмина за окно ${acts.length}`);
    for (const a of acts) {
      if (!TRADE_RE.test(a.title)) continue;
      if (a.num && known.has(`${a.num}@${a.adopted}`)) continue;
      findings.push({ kind: 'new-act', src: 'реестр', text: `${a.title.slice(0, 200)} — в базе не упомянуто: ${a.url}` });
    }
  } catch (err) { errors.push(`реестр НПА: ${err.message}`); }

  // 3. счётчик ГТС
  try {
    const live = parseGtsCounter(await fetchText(GTS_HOME));
    const stored = baseCounter(baseSrc);
    log(`ГТС: счётчик ${JSON.stringify(live)}, в базе ${JSON.stringify(stored)}`);
    // Счётчик растёт каждый день, и письмо о каждой машине никто читать не станет: повод —
    // другой объём квоты (её подняли), исчерпание, о котором карточка ещё не знает, или
    // наоборот остаток при карточке «исчерпана».
    if (!live || live.total == null) errors.push('ГТС: счётчик квоты на странице не найден или сменил имена полей');
    else if (!stored || live.total !== stored.total || (live.left === 0) !== (stored.left === 0)) {
      findings.push({ kind: 'counter', src: 'ГТС', text: `квота электромобилей: на сайте использовано ${live.used} из ${live.total} (остаток ${live.left}), в карточке ${stored ? `${stored.used} из ${stored.total}, остаток ${stored.left}` : 'цифр нет'} — обновить карточку льготы и предупреждение калькулятора` });
    }
  } catch (err) { errors.push(`ГТС: ${err.message}`); }

  // 4. ЕС НСИ ЕАЭС
  try {
    const body = JSON.stringify({ date: today, filter: [], fullTextSearchPhrase: '', offset: 0, limit: 2000, sort: [] });
    const list = JSON.parse(await fetchText(NSI_LIST, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Referer: 'https://nsi.eaeunion.org/portal', Origin: 'https://nsi.eaeunion.org' } }));
    log(`НСИ: справочников ${list.length}`);
    for (const c of nsiChanges(list, NSI_WATCH)) {
      if (c.missing) errors.push(`НСИ: справочника № ${c.code} нет в списке (${c.what})`);
      else findings.push({ kind: 'nsi', src: 'НСИ ЕАЭС', text: `№ ${c.code} «${c.title.slice(0, 120)}» обновлён ${dmyFromIso(c.date)}, база ${c.seen ? `сверена по ${dmyFromIso(c.seen)}` : 'с ним ещё не сверялась'} — ${c.what}: https://nsi.eaeunion.org/portal/${c.code}` });
    }
  } catch (err) { errors.push(`НСИ ЕАЭС: ${err.message}`); }

  const base = require('../src/services/base').load();

  // 5. реестр мер защиты внутреннего рынка ЕЭК (remedies.eaeunion.org, тот же бэкенд spd2,
  // что у портала открытых данных)
  try {
    const reg = JSON.parse(await fetchText(REMEDIES_FIND, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain', Referer: 'https://remedies.eaeunion.org/dimd/ru/security/actions', Origin: 'https://remedies.eaeunion.org' } }));
    const list = reg.result || reg;
    const { missing, stale } = remediesDiff(list, base.ANTIDUMP_DB);
    log(`реестр мер защиты: действующих ${list.filter((m) => m.actual).length}, без пары в базе ${missing.length}, в базе без пары ${stale.length}`);
    for (const m of missing) findings.push({ kind: 'remedy', src: 'ЕЭК', text: `${m.id} «${m.name}» (${m.countries}, коды ${m.codes.join(' ')}) действует по ${dmyFromIso(m.end)} — в базе нет строки с этим кодом и сроком` });
    for (const r of stale) findings.push({ kind: 'remedy', src: 'база', text: `«${r.name}» (срок в базе ${r.end ? dmyFromIso(r.end) : '—'}) — среди действующих мер реестра ЕЭК нет меры с этим кодом и сроком` });
  } catch (err) { errors.push(`реестр мер защиты ЕЭК: ${err.message}`); }

  // 7. ЕТТ ЕАЭС: главы, примечания, список изменяющих решений
  try {
    const r = ettChanges(await fetchText(ETT_PAGE, { headers: { Referer: ETT_PAGE, Origin: 'https://eec.eaeunion.org' } }), require('../private/tnved-notes.json'), ETT_SEEN, today);
    log(`ЕТТ: глав ${r.chapters}, решений в «в ред.» ${r.amendments}, изменений ${r.changes.length}`);
    if (r.chapters < 90 || !r.amendments) errors.push(`ЕТТ: на странице ЕЭК найдено глав ${r.chapters}, решений ${r.amendments} — разметка изменилась`);
    for (const t of r.changes) findings.push({ kind: 'ett', src: 'ЕЭК', text: t });
  } catch (err) { errors.push(`ЕТТ ЕЭК: ${err.message}`); }

  // 8. кыргызские публикации: ТРОИС ГТС, ветеринарные ограничения, темы ГНС, законопроекты
  try {
    const files = troisFiles(await fetchText(TROIS_PAGE));
    log(`ТРОИС: файлов реестра на странице ${files.length}`);
    if (!files.length) errors.push('ТРОИС ГТС: ссылка на реестр на странице не найдена');
    for (const f of files) if (f !== KG_SEEN.trois) findings.push({ kind: 'kg', src: 'ГТС', text: `реестр ТРОИС: на сайте выпуск «${f}», база сверена ${KG_SEEN.trois ? `по «${KG_SEEN.trois}»` : 'по выпуску на 21.08.2026'} — перенести новые и изменённые записи в TROIS_DB: ${TROIS_PAGE}` });
  } catch (err) { errors.push(`ТРОИС ГТС: ${err.message}`); }
  try {
    const media = JSON.parse(await fetchText(VET_MEDIA));
    const last = media.find((m) => /Ограничения на ввоз/i.test((m.title && m.title.rendered) || ''));
    if (!last) errors.push('ветслужба: файл «Ограничения на ввоз» не найден');
    else if (last.date.slice(0, 10) > KG_SEEN.vet) findings.push({ kind: 'kg', src: 'ветслужба', text: `новый файл «Ограничения на ввоз» от ${dmyFromIso(last.date.slice(0, 10))} (сверено по ${dmyFromIso(KG_SEEN.vet)}): ${last.source_url}` });
  } catch (err) { errors.push(`ветслужба vet.gov.kg: ${err.message}`); }
  for (const [theme, t] of Object.entries(KG_SEEN.sti)) {
    try {
      const v = JSON.parse(await fetchText(STI_DOCS(theme))).Value || {};
      const top = (v.List || []).map((d) => ({ d: String(d.DocDate || '').slice(0, 10), n: d.DocNumber, h: String(d.Header || '').replace(/\s+/g, ' ') })).sort((a, b) => (a.d < b.d ? 1 : -1))[0];
      if (!top) errors.push(`ГНС: тема «${t.what}» пуста`);
      else if (top.d > t.seen) findings.push({ kind: 'kg', src: 'ГНС', text: `${t.what}: новый документ ${top.n ? `№ ${top.n} ` : ''}от ${dmyFromIso(top.d)} «${top.h.slice(0, 140)}» (сверено по ${dmyFromIso(t.seen)})` });
    } catch (err) { errors.push(`ГНС sti.gov.kg: ${err.message}`); }
  }
  try {
    const bills = freshBills((JSON.parse(await fetchText(KENESH_DOCS)).content), since);
    log(`Жогорку Кенеш: законопроектов по теме за окно ${bills.length}`);
    for (const b of bills) findings.push({ kind: 'bill', src: 'Кенеш', text: `${b.n} от ${dmyFromIso(b.d)}: ${b.title.slice(0, 200)}` });
  } catch (err) { errors.push(`Жогорку Кенеш: ${err.message}`); }

  // 6. сроки в базе
  for (const m of datedMeasures(base, today)) {
    const when = m.left < 0 ? `истёк ${dmyFromIso(m.date)} (${-m.left} дн. назад)` : `истекает ${dmyFromIso(m.date)} (через ${m.left} дн.)`;
    findings.push({ kind: 'expiry', src: 'база', text: `${m.label} — ${when}${m.note ? ', ' + m.note : ''}` });
  }
  for (const g of dataGaps(base, today)) findings.push({ kind: 'stale', src: 'база', text: g });
  const asof = (baseSrc.match(/UNIMEAS_ASOF='(\d\d\.\d\d\.\d{4})'/) || [])[1];
  if (asof && daysBetween(isoFromDmy(asof), today) > 21) {
    findings.push({ kind: 'stale', src: 'база', text: `реестр односторонних мер ЕЭК разобран по состоянию на ${asof} — ЕЭК обновляет файл раз в две недели` });
  }
  for (const [k, rec] of Object.entries(base.SOURCE_AUDIT || {})) {
    if (rec.d && daysBetween(isoFromDmy(rec.d), today) > 60) findings.push({ kind: 'stale', src: 'аудит', text: `запись ${k} («${rec.n}») последний раз сверялась ${rec.d}` });
  }

  return { today, since, findings, errors };
}

const WATCH_GROUPS = [['new-act', 'Новые акты, которых нет в базе'], ['counter', 'Счётчики'], ['nsi', 'Справочники ЕАЭС обновлены'], ['remedy', 'Меры защиты рынка: реестр ЕЭК и база расходятся'], ['ett', 'ЕТТ: новая редакция на сайте ЕЭК'], ['kg', 'Кыргызские публикации: новый выпуск'], ['bill', 'Законопроекты (раннее предупреждение, не норма)'], ['expiry', 'Сроки'], ['stale', 'Давно не сверялось']];

function renderText({ today, since, findings, errors }) {
  const lines = [`Дозор источников ${dmyFromIso(today)} (окно с ${dmyFromIso(since)})`, ''];
  const groups = WATCH_GROUPS;
  for (const [kind, title] of groups) {
    const items = findings.filter((f) => f.kind === kind);
    if (!items.length) continue;
    lines.push(`## ${title}`);
    for (const f of items) lines.push(`- [${f.src}] ${f.text}`);
    lines.push('');
  }
  if (!findings.length) lines.push('Находок нет.');
  if (errors.length) { lines.push('', '## Источники, которые не ответили'); for (const e of errors) lines.push(`- ${e}`); }
  return lines.join('\n');
}

// Сводка в Telegram администраторам (services/telegram.js): по группам — сколько и первые две
// находки; полный отчёт остаётся в письме. Без TELEGRAM_* в .env — ничего не делает.
async function telegramSummary({ findings, errors }) {
  const telegram = require('../src/services/telegram');
  if (!telegram.enabled()) return;
  const lines = [`📋 <b>Дозор источников: ${findings.length} находок</b>`];
  for (const [kind, title] of WATCH_GROUPS) {
    const items = findings.filter((x) => x.kind === kind);
    if (!items.length) continue;
    lines.push('', `<b>${telegram.esc(title)}</b> — ${items.length}`);
    for (const x of items.slice(0, 2)) lines.push('• ' + telegram.esc(String(x.text).slice(0, 180)));
  }
  if (errors.length) lines.push('', `Не ответили источников: ${errors.length}`);
  lines.push('', 'Полный отчёт — в письме.');
  const n = await telegram.notifyAdmins(lines.join('\n'));
  console.error(`telegram: ${n} адресатов`);
}

async function mail(report, subject) {
  const { pool } = require('../src/db');
  const { sendEmail, renderEmail } = require('../src/services/email');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { rows } = await pool.query("select email from users where role = 'admin' and active = true order by created_at");
  await pool.end();
  const html = renderEmail({
    title: 'Дозор источников',
    intro: 'Ежедневная сверка базы с сайтом Кабинета Министров, реестром НПА, счётчиком ГТС и справочниками ЕАЭС.',
    outro: '<span style="display:block;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:#F4F6FA;border-radius:8px;padding:10px">' + esc(report) + '</span>',
    footNote: 'Письмо отправлено автоматически: tnved-watch-sources.timer → scripts/watch-sources.js --mail.',
  });
  for (const r of rows) await sendEmail({ to: r.email, subject, html });
  return rows.length;
}

async function main() {
  const argv = process.argv.slice(2);
  const days = Number((argv.find((a) => a.startsWith('--days=')) || '').split('=')[1] || (argv.includes('--days') ? argv[argv.indexOf('--days') + 1] : 21));
  const res = await collect({ days, log: (s) => console.error(s) });
  const report = renderText(res);
  console.log(argv.includes('--json') ? JSON.stringify(res, null, 2) : report);
  if (argv.includes('--mail')) {
    // Под таймером находки — не сбой службы: они ушли письмом, код выхода 0, иначе
    // OnFailure слал бы второе письмо о том же.
    if (res.findings.length || res.errors.length) {
      await telegramSummary(res);
      const n = await mail(report, `Дозор источников: ${res.findings.length} находок${res.errors.length ? `, ${res.errors.length} источника без ответа` : ''}`);
      console.error(`письмо отправлено: ${n} адресатов`);
    }
    process.exit(0);
  }
  process.exit(res.errors.length ? 2 : res.findings.length ? 1 : 0);
}

module.exports = { parseGovList, parseGovItem, parseRegistry, parseGtsCounter, nsiChanges, NSI_WATCH, remediesDiff, dataGaps, ettChanges, ETT_SEEN, troisFiles, freshBills, KG_SEEN, knownActs, baseCounter, datedMeasures, collect, renderText, TRADE_RE };
if (require.main === module) main().catch((err) => { console.error(err); process.exit(2); });
