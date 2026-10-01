// Дозор источников: что появилось у государства, чего ещё нет в базе, и что в базе
// вот-вот истечёт. Восемь официальных источников и проверка самой базы:
//
//  1. Сайт Кабинета Министров (gov.kg/ru/npa/c/provisions) — постановления с датой
//     официального опубликования появляются там через день-два после подписания,
//     задолго до индексации в реестре НПА. Каждый свежий акт открывается, текст
//     проверяется на таможенные слова, и если пары «№ N от ДД.ММ.ГГГГ» нет в base.js —
//     это находка.
//  2. Реестр НПА (cbd.minjust.gov.kg, GetDocuments по дате принятия) — те же
//     постановления Кабмина, когда реестр их проиндексирует, плюс ссылка-карточка; и
//     подписанные законы (в том числе об изменении Налогового и Таможенного кодексов,
//     о ратификации торговых соглашений) — законопроект Кенеша становится нормой только так.
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
//     ограничений на ввоз (vet.gov.kg), темы ГНС (sti.gov.kg), редакции актов реестра НПА, по которым
//     сверены ставки (ПКМ № 94 — действующие ставки акциза, Налоговый кодекс, ПКМ № 385 — марки на воду 2201), и любой
//     акт реестра, на редакцию которого ссылается база (kgLinkedEditions); и законопроекты Жогорку Кенеша
//     по таможне и налогам за окно — как раннее предупреждение.
//
//  8. Правовой портал ЕАЭС (docs.eaeunion.org) — решения Коллегии и Совета ЕЭК за окно: по предмету
//     в заголовке (EEC_RE) или потому, что меняют решение, на которое ссылается база (eecNew).
//
// И последнее, без сети: датированные меры базы (запреты, льготы, антидемпинг),
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
const REG_EDITION = (id) => `https://cbd.minjust.gov.kg/api/v1/GetEdition?editionId=${id}&lang=ru`;
// Заголовки вида «О некоторых вопросах …» ничего не говорят о предмете: запреты на вывоз угля (№ 430) и нефтепродуктов
// (№ 615) пришли именно так. У таких постановлений читается текст, как в ветке gov.kg; не больше GENERIC_MAX за прогон.
const GENERIC_RE = /О некоторых вопросах|О мерах по|О вопросах/i;
const GENERIC_MAX = 15;
// Признак меры в прочитанном тексте — строже заголовочного: «таможенный сбор» и «налог» встречаются мимоходом (ПКМ № 609 о
// закупке лекарств), а мера о товаре называет коды ТН ВЭД или вводит запрет. Указы Президента читаются все — их за окно
// единицы, а заголовок моратория на рыбу (УП № 261) о вывозе не говорит.
const TEXT_RE = /ТН ?ВЭД|временн\S* запрет\S*[^.]{0,120}на (?:ввоз|вывоз)|запрет\S* на (?:ввоз|вывоз)|моратори\S* на [^.]{0,160}(?:ввоз|вывоз)/i;
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
  // файл реестра односторонних мер ЕЭК, по которому разобран UNIMEAS_DB (путь medialibrary меняется при каждой загрузке)
  unimeas: 'https://eec.eaeunion.org/upload/medialibrary/edd/29rz9nupyxvkrns97h6afdqg2d0kz8ta/2024_2026.pdf',
  // docs — акты реестра НПА, по которым сверена база (GetDocument): последняя редакция — по наибольшему editionCode
  // (id редакций идут не по времени); refs — число ссылающихся актов: у ПКМ № 94 новый изменяющий акт виден по нему
  // раньше, чем реестр сведёт редакцию. У кодекса ссылок сотни и они растут каждую неделю — там только редакция.
  docs: {
    159100: { what: 'ПКМ КР № 94, приложение 3 — действующие ставки акциза (EXCISE_APPLIED)', seen: { edition: 44256, refs: 34 } },
    112340: { what: 'Налоговый кодекс КР — акциз ст.334/336 (EXCISE_DB), НДС и льготы', seen: { edition: 57656, refs: null } },
    '7-42968': { what: 'ПКМ КР № 385 — учётно-контрольные марки на воду 2201 (MARK_DB m385-water)', seen: { edition: 56661, refs: 3 } },
  },
  sti: {
    'fc8a71a8-13f5-4d35-9ef2-4403bd572759': { what: 'налоговая база НДС с признаками риска (приказ П-347) → карточка НДС-риска', seen: '2026-08-19' },
    '6bd04495-c141-4e8a-be49-a8d384a2d273': { what: 'перечень товаров для прослеживаемости ЕАЭС', seen: '2026-08-28' },
  },
};
const TROIS_PAGE = 'https://www.customs.gov.kg/site/ru/master/customskg/intellektualdyk-menchik-ukuktaryn-korgoo';
const VET_MEDIA = 'https://vet.gov.kg/wp-json/wp/v2/media?search=%D0%BE%D0%B3%D1%80%D0%B0%D0%BD%D0%B8%D1%87%D0%B5%D0%BD&per_page=20&orderby=date&order=desc&_fields=date,source_url,title';
const REG_DOC = (code) => `https://cbd.minjust.gov.kg/api/v1/GetDocument?documentCode=${code}&lang=ru`;
const STI_DOCS = (theme) => `https://sti.gov.kg/api/Documents/get-documents-by-theme-id?themeId=${theme}&language=1&page=1`;
const INTERIM_PAGE = 'https://eec.eaeunion.org/comission/department/catr/nontariff/interim.php';
const KENESH_DOCS = 'https://kenesh.kg/sed/docs?page=0&limit=100';
const BILL_RE = /таможен|налог|акциз|лицензи|ЕАЭС|Евразийск|свободной торговл|нетарифн|технического регулирования|ветеринар|фитосанитар/i;
const REMEDIES_FIND = 'https://remedies.eaeunion.org/spd2/find?collection=zvr.v_actionsregistry&limit=5000';
// Решения Коллегии и Совета ЕЭК — раздел «Решения — <год>» правового портала. Id раздела у каждого года свой и заранее
// неизвестен (2026: Коллегия 463, Совет 461); на год без записи дозор пишет ошибку — добавить id с портала.
const EEC_SECTIONS = { 2026: [[463, 'Коллегии'], [461, 'Совета']] };
const EEC_LIST = (id) => `https://docs.eaeunion.org/documents/${id}/`;
// Предмет, который ведёт база: тариф, квоты, меры защиты, льготы и преференции, нетарифные меры, контроль на границе,
// техрегламенты. Перечни стандартов к ТР и классификационные решения (их забирает services/classDecisions.js) — не находка.
// Изменение «некоторых решений Комиссии Таможенного союза» без номера в заголовке — тоже предмет базы: так названо
// Решение Совета № 18 от 30.01.2026 о льготе на говядину (подп. 7.1.82 Решения КТС № 130), которое ни предмет, ни refActs не ловили.
const EEC_RE = /тариф|пошлин|квот|антидемпинг|защитн\S* мер|компенсацион|триггерн|Товарн\S* номенклатур|ТН ВЭД|преференц|льгот|освобожден|подкарантинн|карантинн\S* фитосанитарн|ветеринарн|санитарн|технически\S* регламент|запрет|лицензир|нетарифн|маркировк|прослеживаем|единого перечня товаров|единый перечень товаров|Комиссии Таможенного союза/i;
// Разобранные решения, которые базу не меняют: «номер@дата принятия» → почему. Решение, которое базу меняет, цитируется
// в base.js (карточка или SOURCE_AUDIT) — тогда оно известно по knownActs и сюда не пишется.
const EEC_REVIEWED = {
  '101@2026-09-09': 'Совет: ЕКФТ, таблица 2 — исключён вирус мозаики пепино; этой таблицы в базе нет',
  '106@2026-09-09': 'Совет: ТР ТС 008/2011 — требование к информации на игрушке; перечень продукции не меняется',
  '115@2026-09-08': 'Коллегия: переходные положения к изменениям ТР ТС 019/2011 (Решение Совета № 40 от 13.03.2026); перечень продукции для декларирования (Коллегия № 79 от 13.06.2012) не меняется',
  '122@2026-09-21': 'Коллегия: классификатор льгот, код ЭК заменён на АК — база и помощник кодов льгот не используют',
};
const BASE_PATH = path.join(__dirname, '..', 'private', 'base.js');
const CHECKER_PATH = path.join(__dirname, '..', 'private', 'checker.js');
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
const TRADE_RE = /запрет|ввоз|вывоз|таможен|налог|ТН ?ВЭД|квот|пошлин|лицензир|акциз|нетарифн|техническ\w* регламент|сертифик|ветеринар|фитосанитар|санитарн|экспорт|импорт/i;

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

// Ответ GetDocuments: постановления Кабинета Министров, (kind 'law') законы, включая
// конституционные, или (kind 'ukaz') указы Президента — мораторий на рыбу озёр Иссык-Куль и
// Сон-Куль (УП № 261 от 17.07.2026) и основа продлений запрета на лом (УП № 375) пришли указами.
function parseRegistry(json, kind = 'pkm') {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  return (d.data || [])
    .filter((x) => kind === 'law' ? /Закон/.test(x.vid || '')
      : kind === 'ukaz' ? /^Указ/.test(x.vid || '') && /Президент/.test(x.organ || '')
        : /^Постановление/.test(x.vid || '') && /Кабинет/.test(x.organ || ''))
    .map((x) => {
      const name = strip(x.nameRu || '');
      const num = (name.match(/№\s*(\d+)/) || [])[1] || null;
      return {
        code: x.documentCode, num, adopted: String(x.dateAdopted || '').slice(0, 10),
        pub: String(x.datePublication || '').slice(0, 10) || null, title: name,
        url: `https://cbd.minjust.gov.kg/${x.documentCode}/edition/${x.lastEdition}/ru`, edition: x.lastEdition || null,
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
// Карточка документа реестра НПА (GetDocument): последняя редакция по editionCode и число ссылающихся актов.
function docEditions(json) {
  const x = (json && json.data && json.data.editions ? json.data : json) || {};
  const eds = (x.editions || []).filter((e) => e && e.id);
  const last = eds.reduce((m, e) => (!m || Number(e.editionCode) > Number(m.editionCode) ? e : m), null);
  return { last: last && { id: last.id, date: String(last.nameRus || '').trim() }, count: eds.length, refs: (x.documentReferences || []).length };
}

// Редакции реестра НПА, по которым сверены строки базы: ссылка «cbd.minjust.gov.kg/<код>/edition/<id>/ru» в base.js
// или checker.js — это и есть редакция сверки. Код → множество id (одну строку могли сверить по одной редакции,
// другую — по следующей). 30.09.2026 так собрано 68 актов, и все, кроме одного разобранного, стояли на последней редакции.
function kgLinkedEditions(...sources) {
  const m = new Map();
  for (const src of sources) {
    for (const [, code, ed] of String(src).matchAll(/cbd\.minjust\.gov\.kg\/(\d[\d-]*)\/edition\/(\d+)\/ru/g)) {
      if (!m.has(code)) m.set(code, new Set());
      m.get(code).add(Number(ed));
    }
  }
  return m;
}

// Ссылки на PDF реестра односторонних мер на странице interim.php (обычно одна).
function interimFiles(html) {
  return [...new Set([...String(html).matchAll(/href="((?:https:\/\/eec\.eaeunion\.org)?\/upload\/medialibrary\/[^"]+\.pdf)"/g)].map((m) => (m[1].startsWith('/') ? 'https://eec.eaeunion.org' + m[1] : m[1])))];
}

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

// Список раздела правового портала ЕАЭС: номер в ссылке, заголовок — в соседнем блоке (docs/legal-sources.md), даты.
function parseEecList(html) {
  return String(html).split('<div class="DocSearchResult_Item">').slice(1).map((b) => {
    const href = (b.match(/href="(\/documents\/\d+\/\d+\/)"/) || [])[1];
    const num = (strip((b.match(/DocSearchResult_Item__Link">([\s\S]*?)<\/a>/) || [])[1] || '').match(/№\s*(\d+)/) || [])[1];
    const date = (re) => { const m = b.match(re); return m ? isoFromDmy(m[1]) : null; };
    return {
      num, url: href && `https://docs.eaeunion.org${href}`, title: strip((b.match(/DocSearchResult_Item__Text">([\s\S]*?)<\/div>/) || [])[1] || ''),
      adopted: date(/Дата принятия документа:\s*(\d\d\.\d\d\.\d{4})/), pub: date(/Дата опубликования документа:\s*(\d\d\.\d\d\.\d{4})/),
      inForce: date(/Дата вступления в силу[^:<]*:\s*(\d\d\.\d\d\.\d{4})/),
    };
  }).filter((d) => d.num && d.url && d.adopted);
}

// «от 20 декабря 2022 г. № 197» в заголовке → ключи knownActs изменяемых решений.
const RU_MONTHS = ['январ', 'феврал', 'март', 'апрел', 'мая', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
function refActs(title) {
  return [...String(title).matchAll(/от (\d{1,2}) ([а-я]+) (\d{4}) г\. № (\d+)/g)].flatMap((m) => {
    const mi = RU_MONTHS.findIndex((p) => m[2].startsWith(p));
    return mi < 0 ? [] : [`${m[4]}@${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`];
  });
}

// Свежие решения, которых база не знает: по предмету в заголовке или потому, что меняют решение, на которое база
// ссылается, — у изменяющих решений заголовок пустой («О внесении изменения в Решение … № 197»), так пришли
// отмена ценовых обязательств по задвижкам (№ 125/2026) и квоты Ирана на 2027 год (№ 119/2026).
function eecNew(items, known, since, reviewed = EEC_REVIEWED) {
  return items
    .filter((d) => (d.pub || d.adopted) >= since && !/^О классификации/.test(d.title)
      && !known.has(`${d.num}@${d.adopted}`) && !reviewed[`${d.num}@${d.adopted}`])
    .map((d) => ({ ...d, amends: refActs(d.title).filter((k) => known.has(k)) }))
    .filter((d) => d.amends.length || (EEC_RE.test(d.title) && !/стандарт/i.test(d.title)));
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
// Изменения, которые вступают в силу в известный день, а в базе требуют правки, не знающей дат (TNVED_MAP, перечни):
// правка готовится веткой заранее и выкладывается в этот день. За неделю до даты и после неё, пока правка не внесена
// (done — проверка по самой базе), — находка.
const DATED_SWITCH = [
  { on: '2026-10-08', done: (b) => !(b.TNVED_MAP && b.TNVED_MAP['8112924101']),
    text: 'с 08.10.2026 код 8112 92 410 0 исключён, введены 8112 92 410 1 (ниобий-алюминиевая лигатура) и 8112 92 410 9 (Решение Коллегии ЕЭК № 112 от 25.08.2026; в перечне ЕСТП — Решение Совета ЕЭК № 100 от 09.09.2026): выложить ветку claude/ett-8112-split' },
];

function dataGaps(base, today) {
  const out = [];
  for (const d of DATED_SWITCH) if (daysBetween(today, d.on) <= 7 && !d.done(base)) out.push(d.text);
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
  // Годы квоты по наименованию («2026-2028» — все три). Есть следующий год, а текущего нет — так до 30.09.2026
  // в базе не было риса из Вьетнама на 2026 год (Решение № 86), хотя 2027 год был.
  // Строка, в примечании которой «на 2027 год … не найдено», уже проверена: решения на следующий год на портале ещё нет
  // (льгота на говядину 7.1.82, 01.10.2026), и находка не повторяется; новое решение принесёт раздел решений ЕЭК.
  const year = Number(today.slice(0, 4));
  const years = {}, searched = new Set();
  for (const q of base.QUOTA_DB || []) {
    const ys = String(q[2]).match(/\d{4}/g).map(Number), s = years[q[1]] || (years[q[1]] = new Set());
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) s.add(y);
    const m = String(q[5] || '').match(/на (\d{4}) год[^;]{0,80}?не найден/i);
    if (m && Number(m[1]) === year + 1) searched.add(q[1]);
  }
  for (const [name, s] of Object.entries(years)) {
    if (s.has(year + 1) && !s.has(year)) out.push(`квота «${name.slice(0, 80)}» есть на ${year + 1} год, а на текущий ${year} в базе нет`);
    if (today.slice(5) >= '10-01' && Math.max(...s) === year && !searched.has(name)) out.push(`квота «${name.slice(0, 80)}» есть только по ${year} год — решения на ${year + 1} в базе нет`);
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
    const acts = [], laws = [], ukazes = [];
    const day = async (d, filter, kind) => {
      const body = JSON.stringify({ dateAdoptedFrom: d, dateAdoptedTo: d, ...filter });
      const parsed = JSON.parse(await fetchText(REG_SEARCH, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }));
      if ((parsed.data || []).length < (parsed.totalResultsCount || 0)) errors.push(`реестр НПА: за ${dmyFromIso(d)} ${kind === 'law' ? 'законов' : 'актов'} ${parsed.totalResultsCount}, получено ${parsed.data.length} — день просмотрен не целиком`);
      return parseRegistry(parsed, kind);
    };
    for (let d = since; d <= today; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) {
      // refTypeId 0050 = «Постановление», authoritiesId 0040.0011 = Кабинет Министров КР —
      // коды классификатора реестра, видны в карточке любого ПКМ (GetDocument); без них в
      // 12 записей дня попадают законы и приказы, а постановления остаются за бортом.
      // refTypeId 0020 = «Закон» (с конституционными; орган не задаём — у части законов о
      // ратификации в реестре стоит Кабмин).
      if (d !== since) await sleep(1500);
      acts.push(...await day(d, { refTypeId: '0050', authoritiesId: '0040.0011' }, 'pkm'));
      await sleep(1500);
      laws.push(...await day(d, { refTypeId: '0020' }, 'law'));
      // refTypeId 0072 = «Указ», орган 0020.1 = Президент (карточка УП № 261 в реестре).
      await sleep(1500);
      ukazes.push(...await day(d, { refTypeId: '0072', authoritiesId: '0020.1' }, 'ukaz'));
    }
    log(`реестр: постановлений Кабмина за окно ${acts.length}, законов ${laws.length}, указов ${ukazes.length}`);
    let generic = 0;
    for (const a of acts) {
      let trade = TRADE_RE.test(a.title);
      if (!trade && GENERIC_RE.test(a.title) && a.edition && !(a.num && known.has(`${a.num}@${a.adopted}`))) {
        if (++generic > GENERIC_MAX) { if (generic === GENERIC_MAX + 1) errors.push(`реестр НПА: постановлений с общим заголовком больше ${GENERIC_MAX} — остальные не прочитаны`); continue; }
        await sleep(1500);
        try { trade = TEXT_RE.test(strip(JSON.parse(await fetchText(REG_EDITION(a.edition))).contentRu || '')); } catch (err) { errors.push(`реестр НПА, текст ${a.url}: ${err.message}`); }
      }
      if (!trade) continue;
      if (a.num && known.has(`${a.num}@${a.adopted}`)) continue;
      findings.push({ kind: 'new-act', src: 'реестр', text: `${a.title.slice(0, 200)} — в базе не упомянуто: ${a.url}` });
    }
    for (const a of ukazes) {
      if (a.num && known.has(`${a.num}@${a.adopted}`)) continue;
      // у указов «запрет» в заголовке бывает и о проверках бизнеса (УП № 327) — судит только TEXT_RE
      let trade = TEXT_RE.test(a.title);
      if (!trade && a.edition) {
        await sleep(1500);
        try { trade = TEXT_RE.test(strip(JSON.parse(await fetchText(REG_EDITION(a.edition))).contentRu || '')); } catch (err) { errors.push(`реестр НПА, текст ${a.url}: ${err.message}`); }
      }
      if (!trade) continue;
      findings.push({ kind: 'new-act', src: 'реестр, указ', text: `${a.title.slice(0, 220)} — в базе не упомянуто: ${a.url}` });
    }
    // Закон — шире: налоговые и таможенные слова законопроектов (BILL_RE) плюс торговые.
    for (const a of laws) {
      if (!TRADE_RE.test(a.title) && !BILL_RE.test(a.title)) continue;
      if (a.num && known.has(`${a.num}@${a.adopted}`)) continue;
      findings.push({ kind: 'new-act', src: 'реестр, закон', text: `${a.title.slice(0, 220)} — подписан; проверить, меняет ли ставки, льготы, запреты или порядок ввоза: ${a.url}` });
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

  // 7а. решения Коллегии и Совета ЕЭК за окно (правовой портал ЕАЭС)
  for (const y of new Set([since.slice(0, 4), today.slice(0, 4)])) {
    if (!EEC_SECTIONS[y]) { errors.push(`правовой портал ЕАЭС: нет разделов «Решения — ${y}» — добавить id в EEC_SECTIONS`); continue; }
    for (const [id, body] of EEC_SECTIONS[y]) {
      try {
        const items = parseEecList(await fetchText(EEC_LIST(id), { headers: { Referer: 'https://docs.eaeunion.org/', Origin: 'https://docs.eaeunion.org' } }));
        if (!items.length) { errors.push(`правовой портал ЕАЭС: в разделе ${id} (решения ${body} ${y}) решений не найдено — разметка изменилась`); continue; }
        const fresh = eecNew(items, known, since);
        log(`ЕЭК, решения ${body} ${y}: на странице ${items.length}, новых для базы ${fresh.length}`);
        for (const d of fresh) {
          const amends = d.amends.map((k) => `№ ${k.split('@')[0]} от ${dmyFromIso(k.split('@')[1])}`).join(', ');
          findings.push({ kind: 'new-act', src: 'ЕЭК', text: `Решение ${body} ЕЭК № ${d.num} от ${dmyFromIso(d.adopted)} «${d.title.slice(0, 200)}»${amends ? ` — изменяет решение, на которое ссылается база (${amends})` : ''}; опубликовано ${d.pub ? dmyFromIso(d.pub) : '—'}${d.inForce ? `, в силу ${dmyFromIso(d.inForce)}` : ''}: ${d.url}` });
        }
      } catch (err) { errors.push(`правовой портал ЕАЭС, раздел ${id}: ${err.message}`); }
    }
  }

  // 8. кыргызские публикации: ТРОИС ГТС, ветеринарные ограничения, темы ГНС, законопроекты
  try {
    const files = troisFiles(await fetchText(TROIS_PAGE));
    log(`ТРОИС: файлов реестра на странице ${files.length}`);
    if (!files.length) errors.push('ТРОИС ГТС: ссылка на реестр на странице не найдена');
    for (const f of files) if (f !== KG_SEEN.trois) findings.push({ kind: 'kg', src: 'ГТС', text: `реестр ТРОИС: на сайте выпуск «${f}», база сверена ${KG_SEEN.trois ? `по «${KG_SEEN.trois}»` : 'по выпуску на 21.08.2026'} — перенести новые и изменённые записи в TROIS_DB: ${TROIS_PAGE}` });
  } catch (err) { errors.push(`ТРОИС ГТС: ${err.message}`); }
  try {
    const files = interimFiles(await fetchText(INTERIM_PAGE, { headers: { Referer: INTERIM_PAGE, Origin: 'https://eec.eaeunion.org' } }));
    if (!files.length) errors.push('реестр односторонних мер ЕЭК: ссылка на файл на странице не найдена');
    else if (!files.includes(KG_SEEN.unimeas)) findings.push({ kind: 'kg', src: 'ЕЭК', text: `реестр односторонних мер: на странице новый файл ${files[0]} (база разобрана по ${KG_SEEN.unimeas.split('/').slice(-2).join('/')}) — сверить кыргызский раздел по актам и поднять UNIMEAS_ASOF и KG_SEEN.unimeas` });
  } catch (err) { errors.push(`реестр односторонних мер ЕЭК: ${err.message}`); }
  try {
    const media = JSON.parse(await fetchText(VET_MEDIA));
    const last = media.find((m) => /Ограничения на ввоз/i.test((m.title && m.title.rendered) || ''));
    if (!last) errors.push('ветслужба: файл «Ограничения на ввоз» не найден');
    else if (last.date.slice(0, 10) > KG_SEEN.vet) findings.push({ kind: 'kg', src: 'ветслужба', text: `новый файл «Ограничения на ввоз» от ${dmyFromIso(last.date.slice(0, 10))} (сверено по ${dmyFromIso(KG_SEEN.vet)}): ${last.source_url}` });
  } catch (err) { errors.push(`ветслужба vet.gov.kg: ${err.message}`); }
  for (const [code, t] of Object.entries(KG_SEEN.docs)) {
    try {
      const r = docEditions(JSON.parse(await fetchText(REG_DOC(code))));
      if (!r.last) errors.push(`реестр НПА: у документа ${code} нет редакций`);
      else if (r.last.id !== t.seen.edition) findings.push({ kind: 'kg', src: 'реестр', text: `${t.what}: новая редакция от ${r.last.date} (${r.last.id}), база сверена по ${t.seen.edition} — сверить` });
      else if (t.seen.refs !== null && r.refs > t.seen.refs) findings.push({ kind: 'kg', src: 'реестр', text: `${t.what}: ссылающихся актов стало ${r.refs} (было ${t.seen.refs}) — возможно, изменяющий акт ещё не сведён в редакцию` });
    } catch (err) { errors.push(`реестр НПА, документ ${code}: ${err.message}`); }
  }
  // Все акты, на редакцию которых ссылается база: новая редакция — строки базы сверены по прежней.
  // Акты из KG_SEEN.docs уже проверены выше (там ещё и число ссылающихся актов) — их редакции пропускаются.
  const seenEds = new Set(Object.values(KG_SEEN.docs).map((t) => t.seen.edition));
  const linked = kgLinkedEditions(baseSrc, fs.readFileSync(CHECKER_PATH, 'utf8'));
  let staleEds = 0;
  for (const [code, eds] of linked) {
    if ([...eds].some((e) => seenEds.has(e))) continue;
    try {
      await sleep(1500);
      const doc = JSON.parse(await fetchText(REG_DOC(code)));
      const r = docEditions(doc);
      if (!r.last) { errors.push(`реестр НПА: у документа ${code} нет редакций`); continue; }
      if (eds.has(r.last.id)) continue;
      staleEds++;
      const name = String((doc.data || doc).nameRus || code).replace(/\s+/g, ' ').trim().slice(0, 160);
      findings.push({ kind: 'kg', src: 'реестр', text: `${name}: в базе ссылка на редакцию ${[...eds].join(', ')}, в реестре новая — от ${r.last.date} (${r.last.id}) — сверить строки базы и поднять ссылку: https://cbd.minjust.gov.kg/${code}/edition/${r.last.id}/ru` });
    } catch (err) { errors.push(`реестр НПА, документ ${code}: ${err.message}`); }
  }
  log(`реестр НПА: актов со ссылкой на редакцию в базе ${linked.size}, с новой редакцией ${staleEds}`);
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
  if (require('../src/services/ops').routineEnabled()) lines.push('Ответьте на это сообщение «разобрать» — Claude разберёт находки и пришлёт, что меняет.');
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
      // Полный отчёт — для «разобрать» из Telegram без ответа на сводку (routes/ops.js).
      try { require('../src/services/ops').saveWatchReport(report); } catch (err) { console.error('ops: ' + err.message); }
      await telegramSummary(res);
      const n = await mail(report, `Дозор источников: ${res.findings.length} находок${res.errors.length ? `, ${res.errors.length} источника без ответа` : ''}`);
      console.error(`письмо отправлено: ${n} адресатов`);
    }
    process.exit(0);
  }
  process.exit(res.errors.length ? 2 : res.findings.length ? 1 : 0);
}

module.exports = { TEXT_RE, interimFiles, kgLinkedEditions, parseEecList, refActs, eecNew, EEC_REVIEWED, docEditions, parseGovList, parseGovItem, parseRegistry, parseGtsCounter, nsiChanges, NSI_WATCH, remediesDiff, dataGaps, ettChanges, ETT_SEEN, troisFiles, freshBills, KG_SEEN, knownActs, baseCounter, datedMeasures, collect, renderText, TRADE_RE, BILL_RE };
if (require.main === module) main().catch((err) => { console.error(err); process.exit(2); });
