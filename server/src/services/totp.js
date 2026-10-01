// Второй фактор входа для администраторов (01.10.2026): одноразовые коды TOTP (RFC 6238 — HMAC-SHA1, 6 цифр, шаг 30 с),
// те же, что показывают Google Authenticator, Microsoft Authenticator, 1Password и другие приложения.
//
// Секрет в базе — не открытым текстом: AES-256-GCM с ключом из SESSION_SECRET (HMAC «totp-secret-v1»). Копия базы
// (резервная копия на машине владельца) без .env сервера второй фактор не выдаёт. Коды восстановления — восемь
// одноразовых, хранятся SHA-256 (энтропия кода ~50 бит, перебор хеша бессмыслен), показываются один раз.
// Один и тот же код дважды не принимается: номер шага последнего принятого кода хранится (totp_last_step).
const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;
const ISSUER = 'Customs Assist KG';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(key, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP);

// Код из приложения → номер шага, которому он соответствует, или null. Допуск — шаг в обе стороны (часы телефона
// и сервера расходятся), шаги не новее lastStep не принимаются (повтор подсмотренного кода).
function verify(key, code, { now = Date.now(), lastStep = null, window = 1 } = {}) {
  const c = String(code == null ? '' : code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepAt(now);
  for (let s = cur - window; s <= cur + window; s++) {
    if (lastStep != null && s <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(c))) return s;
  }
  return null;
}

const newSecret = () => crypto.randomBytes(20);

function otpauthUri(secret, account) {
  const label = encodeURIComponent(ISSUER) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

// QR-код адреса otpauth — картинкой data: (CSP пускает img-src data:), SVG на белом фоне: приложение сканирует его и
// в тёмной теме. Библиотека — server/src/vendor/qrcode-generator.js (MIT), без установки пакетов.
function qrDataUrl(text) {
  const qrcode = require('../vendor/qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return 'data:image/svg+xml;base64,' + Buffer.from(qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })).toString('base64');
}

// ── Секрет в базе ──
function sealKey() {
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set');
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update('totp-secret-v1').digest();
}
function seal(secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function unseal(stored) {
  const m = /^v1:([A-Za-z0-9+/=]+)$/.exec(String(stored || ''));
  if (!m) throw new Error('bad sealed secret');
  const raw = Buffer.from(m[1], 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

// ── Коды восстановления: «ABCD-EFGH», без похожих букв; в базе — SHA-256 нормализованного кода ──
const REC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(8);
    const s = Array.from(b, (x) => REC[x & 31]).join('');
    return s.slice(0, 4) + '-' + s.slice(4);
  });
}
const normRecovery = (code) => String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashRecovery = (code) => crypto.createHash('sha256').update(normRecovery(code)).digest('hex');
// Индекс совпавшего кода в списке хешей или -1. Сравнение — постоянного времени по всем кодам.
function matchRecovery(hashes, code) {
  const n = normRecovery(code);
  if (n.length !== 8) return -1;
  const h = Buffer.from(hashRecovery(n));
  let found = -1;
  (Array.isArray(hashes) ? hashes : []).forEach((x, i) => {
    const b = Buffer.from(String(x));
    if (b.length === h.length && crypto.timingSafeEqual(b, h) && found < 0) found = i;
  });
  return found;
}

module.exports = { base32Encode, base32Decode, hotp, verify, stepAt, newSecret, otpauthUri, qrDataUrl, seal, unseal, newRecoveryCodes, hashRecovery, matchRecovery, STEP, ISSUER };
