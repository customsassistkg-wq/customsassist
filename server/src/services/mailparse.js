// Разбор входящего письма (RFC 5322 и MIME) без внешних зависимостей.
//
// Почему своими руками, а не библиотекой: у сервиса шесть зависимостей на весь backend, а
// mailparser тянет за собой десяток пакетов ради того, что здесь нужно в объёме «тема,
// адреса, текст и список вложений». Всё, что этот разбор делает, проверяется на образцах
// писем в tests/mail.test.js: кодированные слова, base64, quoted-printable, windows-1251,
// multipart/alternative и multipart/mixed с вложением.
//
// Сознательное решение: HTML-часть письма НЕ сохраняется. Если текстовой части нет, HTML
// превращается в текст здесь же. Так в админ-панель никогда не попадает чужая разметка,
// и целый класс рисков (скрипт, картинка-маячок, подменённая ссылка в письме от
// незнакомого человека) не возникает вовсе.
'use strict';

const MAX_PARTS = 300;   // защита от письма-бомбы с тысячами частей
const MAX_DEPTH = 12;    // вложенность multipart

// ── Заголовки ────────────────────────────────────────────────────────────────
function splitHeaderBody(buf) {
  const a = buf.indexOf('\r\n\r\n');
  const b = buf.indexOf('\n\n');
  if (a >= 0 && (b < 0 || a <= b)) return [buf.subarray(0, a), buf.subarray(a + 4)];
  if (b >= 0) return [buf.subarray(0, b), buf.subarray(b + 2)];
  return [buf, buf.subarray(buf.length)];
}

// Значение заголовка может быть перенесено на следующую строку с отступом (RFC 5322, 2.2.3).
function parseHeaders(buf) {
  const raw = buf.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const list = [];
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) list.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
  }
  return {
    list,
    get(name) { const f = list.find((h) => h[0] === name); return f ? f[1] : ''; },
    all(name) { return list.filter((h) => h[0] === name).map((h) => h[1]); },
  };
}

// Кодированные слова: =?windows-1251?Q?...?= и =?UTF-8?B?...?= (RFC 2047).
function decodeWords(s) {
  if (!s || s.indexOf('=?') < 0) return s || '';
  // Пробел между двумя соседними кодированными словами не значит ничего (RFC 2047, 6.2).
  const joined = s.replace(/\?=\s+=\?/g, '?==?');
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
    try {
      const buf = enc.toUpperCase() === 'B'
        ? Buffer.from(txt, 'base64')
        : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return decodeText(buf, cs);
    } catch (e) {
      return m;
    }
  });
}

// ── Тело ─────────────────────────────────────────────────────────────────────
function decodeText(buf, charset) {
  let cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (cs === 'cp1251' || cs === 'win-1251') cs = 'windows-1251';
  if (cs === 'utf8') cs = 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch (e) { /* неизвестная кодировка */ }
  try { return new TextDecoder('utf-8').decode(buf); } catch (e) { return buf.toString('latin1'); }
}

function decodeQP(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x3d) { // '='
      if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) { i += 2; continue; } // мягкий перенос строки
      if (buf[i + 1] === 0x0a) { i += 1; continue; }
      const hex = buf.subarray(i + 1, i + 3).toString('latin1');
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out[j++] = parseInt(hex, 16); i += 2; continue; }
    }
    out[j++] = buf[i];
  }
  return out.subarray(0, j);
}

function decodeBody(buf, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQP(buf);
  return buf;
}

// ── Параметры Content-Type и Content-Disposition ─────────────────────────────
function parseParams(value) {
  const out = {};
  const re = /;\s*([\w.*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let m;
  while ((m = re.exec(value))) {
    let key = m[1].toLowerCase();
    let val = m[2].trim();
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    const starred = key.endsWith('*');
    if (starred) {
      key = key.slice(0, -1);
      // RFC 2231: charset'язык'процентное-кодирование
      const mm = /^([^']*)'([^']*)'(.*)$/.exec(val);
      if (mm) {
        const bytes = Buffer.from(mm[3].replace(/%([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
        val = decodeText(bytes, mm[1] || 'utf-8');
      }
    }
    if (starred || out[key] === undefined) out[key] = decodeWords(val);
  }
  return out;
}

const mainType = (v) => String(v || '').split(';')[0].trim().toLowerCase();

// ── Разбор частей ────────────────────────────────────────────────────────────
function splitParts(body, boundary) {
  const delim = Buffer.from('--' + boundary, 'latin1');
  const marks = [];
  let from = 0;
  for (;;) {
    const i = body.indexOf(delim, from);
    if (i < 0) break;
    if (i === 0 || body[i - 1] === 0x0a) marks.push(i);
    from = i + delim.length;
    if (marks.length > MAX_PARTS) break;
  }
  const parts = [];
  for (let k = 0; k + 1 < marks.length; k++) {
    let start = marks[k] + delim.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // закрывающий разделитель
    while (body[start] === 0x0d || body[start] === 0x0a) start++;
    let end = marks[k + 1];
    while (end > start && (body[end - 1] === 0x0a || body[end - 1] === 0x0d)) end--;
    parts.push(body.subarray(start, end));
  }
  return parts;
}

// Текст из HTML: только для писем без текстовой части. Разметка не сохраняется.
function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Адрес вида «Имя <a@b.c>» или «a@b.c».
function parseAddress(value) {
  const s = decodeWords(String(value || '')).trim();
  const m = /^(.*?)<([^>]+)>\s*$/.exec(s);
  if (m) {
    let name = m[1].trim().replace(/^"|"$/g, '').trim();
    return { name, address: m[2].trim().toLowerCase() };
  }
  return { name: '', address: s.replace(/^<|>$/g, '').trim().toLowerCase() };
}

function parseMessage(buf) {
  const text = [];
  const html = [];
  const attachments = [];
  let parts = 0;

  function walk(section, depth) {
    if (depth > MAX_DEPTH || parts > MAX_PARTS) return;
    parts++;
    const [head, body] = splitHeaderBody(section);
    const h = parseHeaders(head);
    const ct = h.get('content-type') || 'text/plain';
    const type = mainType(ct);
    const params = parseParams(ct);
    const disp = h.get('content-disposition');
    const dispParams = parseParams(disp);
    const filename = dispParams.filename || params.name || '';
    const attached = mainType(disp) === 'attachment' || (filename && !type.startsWith('text/'));

    if (type.startsWith('multipart/') && params.boundary) {
      for (const p of splitParts(body, params.boundary)) walk(p, depth + 1);
      return;
    }
    if (attached) {
      // Содержимое вложения не сохраняется: в базу идут только имя, тип и размер.
      const enc = String(h.get('content-transfer-encoding') || '').toLowerCase();
      const size = enc === 'base64' ? Math.floor(body.toString('latin1').replace(/\s/g, '').length * 3 / 4) : body.length;
      attachments.push({ filename: filename || 'без имени', type: type || 'application/octet-stream', size });
      return;
    }
    if (type === 'text/plain' || type === 'text/html' || type === '' ) {
      const decoded = decodeText(decodeBody(body, h.get('content-transfer-encoding')), params.charset);
      (type === 'text/html' ? html : text).push(decoded);
    }
  }

  walk(buf, 0);

  const h = parseHeaders(splitHeaderBody(buf)[0]);
  const from = parseAddress(h.get('from'));
  const refs = (h.get('references') || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const inReplyTo = (h.get('in-reply-to') || '').trim();
  const body = text.join('\n\n').trim() || htmlToText(html.join('\n\n'));
  return {
    messageId: (h.get('message-id') || '').trim() || null,
    inReplyTo: inReplyTo || null,
    references: refs,
    date: h.get('date') || null,
    from: from.address,
    fromName: from.name || null,
    to: parseAddress(h.get('to')).address || null,
    subject: decodeWords(h.get('subject')).trim(),
    text: body,
    hadHtml: html.length > 0,
    attachments,
    authResults: (h.get('authentication-results') || '').slice(0, 500) || null,
    autoSubmitted: /auto-(replied|generated|notified)/i.test(h.get('auto-submitted') || '') || !!h.get('list-id'),
  };
}

module.exports = { parseMessage, decodeWords, decodeQP, decodeBody, decodeText, parseParams, parseAddress, htmlToText, splitHeaderBody, splitParts };
