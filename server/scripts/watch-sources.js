// Дозор источников: что появилось у государства, чего ещё нет в базе, и что в базе
// вот-вот истечёт. Три вопроса, три официальных места:
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
// И пятое, без сети: датированные меры базы (запреты, льготы, антидемпинг),
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const GOV_LIST = 'https://www.gov.kg/ru/npa/c/provisions';
const REG_SEARCH = 'https://cbd.minjust.gov.kg/api/v1/GetDocuments';
const GTS_HOME = 'https://www.customs.gov.kg/site/ru/master/customskg';
const NSI_LIST = 'https://nsi.eaeunion.org/portal/api/registries/get-list-data';
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
      headers: { 'User-Agent': UA, Referer: 'https://cbd.minjust.gov.kg/', Origin: 'https://cbd.minjust.gov.kg', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${url} → HTTP ${res.statusCode}`));
        resolve(Buffer.concat(chunks).toString('utf8'));
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
function datedMeasures(base, today, horizon = 14, grace = 30) {
  const out = [];
  const add = (label, date, note) => {
    if (!date) return;
    const left = daysBetween(today, date);
    if (left <= horizon && left >= -grace) out.push({ label, date, left, note });
  };
  for (const e of base.BAN_DB || []) {
    const name = (e.name || '').slice(0, 90);
    add(`запрет ввоза: ${name}`, e.imUntil, e.imN && /продлен|истёк/.test(e.imN) ? '' : 'проверить продление');
    add(`запрет вывоза: ${name}`, e.exUntil, e.exN && /продлен|истёк/.test(e.exN) ? '' : 'проверить продление');
    add(`льгота: ${name}`, e['льгUntil'], '');
  }
  for (const r of base.ANTIDUMP_DB || []) add(`антидемпинг: ${String(r[1] || '').slice(0, 90)}`, r[6], '');
  return out.sort((a, b) => a.left - b.left);
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

  // 5. сроки в базе
  const base = require('../src/services/base').load();
  for (const m of datedMeasures(base, today)) {
    const when = m.left < 0 ? `истёк ${dmyFromIso(m.date)} (${-m.left} дн. назад)` : `истекает ${dmyFromIso(m.date)} (через ${m.left} дн.)`;
    findings.push({ kind: 'expiry', src: 'база', text: `${m.label} — ${when}${m.note ? ', ' + m.note : ''}` });
  }
  const asof = (baseSrc.match(/UNIMEAS_ASOF='(\d\d\.\d\d\.\d{4})'/) || [])[1];
  if (asof && daysBetween(isoFromDmy(asof), today) > 21) {
    findings.push({ kind: 'stale', src: 'база', text: `реестр односторонних мер ЕЭК разобран по состоянию на ${asof} — ЕЭК обновляет файл раз в две недели` });
  }
  for (const [k, rec] of Object.entries(base.SOURCE_AUDIT || {})) {
    if (rec.d && daysBetween(isoFromDmy(rec.d), today) > 60) findings.push({ kind: 'stale', src: 'аудит', text: `запись ${k} («${rec.n}») последний раз сверялась ${rec.d}` });
  }

  return { today, since, findings, errors };
}

function renderText({ today, since, findings, errors }) {
  const lines = [`Дозор источников ${dmyFromIso(today)} (окно с ${dmyFromIso(since)})`, ''];
  const groups = [['new-act', 'Новые акты, которых нет в базе'], ['counter', 'Счётчики'], ['nsi', 'Справочники ЕАЭС обновлены'], ['expiry', 'Сроки'], ['stale', 'Давно не сверялось']];
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
      const n = await mail(report, `Дозор источников: ${res.findings.length} находок${res.errors.length ? `, ${res.errors.length} источника без ответа` : ''}`);
      console.error(`письмо отправлено: ${n} адресатов`);
    }
    process.exit(0);
  }
  process.exit(res.errors.length ? 2 : res.findings.length ? 1 : 0);
}

module.exports = { parseGovList, parseGovItem, parseRegistry, parseGtsCounter, nsiChanges, NSI_WATCH, knownActs, baseCounter, datedMeasures, collect, renderText, TRADE_RE };
if (require.main === module) main().catch((err) => { console.error(err); process.exit(2); });
