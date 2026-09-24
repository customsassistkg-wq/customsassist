// Клиент xPay (https://developer.xpay.kg, API 1.7): вход по client_id/secret, динамический QR,
// статус QR. Суммы у xPay — в тыйынах целым числом и при создании, и в статусе (проверено в
// тестовой среде 24.09.2026; пример «240.00000000» в документации устарел).
// Ключи — только в .env: XPAY_CLIENT_ID, XPAY_CLIENT_SECRET; XPAY_API — https://api.xpay.kg
// в боевой среде, по умолчанию тестовая https://devapi.xpay.kg. XPAY_SERVICE_UUID — какую
// услугу брать, если их у пользователя xPay несколько; без него — первая из ответа на вход.
const API = () => (process.env.XPAY_API || 'https://devapi.xpay.kg').replace(/\/+$/, '');
const TIMEOUT_MS = 15000;

function enabled() {
  return !!(process.env.XPAY_CLIENT_ID && process.env.XPAY_CLIENT_SECRET);
}

async function call(method, path, body, token) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.status !== 'Success' || !j.data) {
    throw new Error(`xpay ${path}: HTTP ${res.status} ${j ? JSON.stringify(j.message ?? j).slice(0, 300) : ''}`.trim());
  }
  return j.data;
}

// Токен живёт 30 минут; берём новый за две минуты до конца.
let session = null;
async function auth() {
  if (session && session.until > Date.now() + 120e3) return session;
  const d = await call('POST', '/api/v1/developer/login', { client_id: process.env.XPAY_CLIENT_ID, client_secret: process.env.XPAY_CLIENT_SECRET });
  const svc = (d.service || []).find((s) => !process.env.XPAY_SERVICE_UUID || s.uuid === process.env.XPAY_SERVICE_UUID);
  if (!svc) throw new Error('xpay: service not found');
  const until = Date.parse(d.expires_at);
  session = { token: d.access_token, uuid: svc.uuid, until: Number.isFinite(until) ? Math.min(until, Date.now() + 30 * 60e3) : Date.now() + 25 * 60e3 };
  return session;
}

// amount — в тыйынах. Возвращает { qr_transaction_id, qr_code (ссылка pay.xpay.kg), qr_image, amount, payable }.
// service_name и comments — не длиннее 32 знаков: иначе 409 (в документации не сказано, найдено в тестовой среде).
async function createQr({ amount, orderId, name, callbackUrl, checkUrl, returnUrl }) {
  const s = await auth();
  name = String(name).slice(0, 32);
  return call('POST', '/api/v1/developer/qr/get', {
    uuid: s.uuid, type: 'dynamic', amount, amount_change: false,
    service_id: String(orderId), service_name: name, comments: name,
    callback_url: callbackUrl, check_url: checkUrl, return_url: returnUrl,
  }, s.token);
}

// pay_status: WAITING, SCANNED, ACTIVE, PROCESSING — промежуточные; COMPLETED, ERROR, CANCELED — конечные.
async function qrStatus(txId) {
  const s = await auth();
  return call('GET', '/api/v1/developer/qr/dynamic/status/' + encodeURIComponent(txId), null, s.token);
}

module.exports = { enabled, createQr, qrStatus, _reset: () => { session = null; } };
