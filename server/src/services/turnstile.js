// Проверка Cloudflare Turnstile.
//
// Turnstile — самостоятельный продукт Cloudflare и **не требует, чтобы домен
// проксировался через Cloudflare**. У customsassist.trade записи стоят в режиме
// DNS-only, и это ему не мешает: нужен только аккаунт, где заведён виджет.
//
// Ключи берутся из окружения:
//   TURNSTILE_SITE_KEY    — публичный, уходит в браузер, не секрет;
//   TURNSTILE_SECRET_KEY  — секретный, только на сервере.
//
// **Пока секретного ключа нет, проверка не выполняется и всё работает как
// раньше.** Это сделано намеренно: код можно выкатить до того, как ключи
// заведены, не отрезав регистрацию. Как только ключ появится в .env и служба
// перезапустится, проверка включится сама, без правок кода и без повторного
// выката страницы.
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function siteKey() {
  return String(process.env.TURNSTILE_SITE_KEY || '').trim();
}

function secretKey() {
  return String(process.env.TURNSTILE_SECRET_KEY || '').trim();
}

// Включённость определяется наличием СЕКРЕТНОГО ключа, а не публичного:
// публичный сам по себе ничего не проверяет, и ориентироваться на него значило
// бы рисовать виджет, ответ которого никто не смотрит.
function isEnabled() {
  return secretKey().length > 0;
}

// Разрешённые имена хостов берём из APP_ORIGIN: виджет заведён на
// customsassist.trade, и токен, выпущенный где-то ещё, нам не годится.
function allowedHostnames() {
  const raw = process.env.PUBLIC_ORIGIN || process.env.APP_ORIGIN || '';
  const out = [];
  for (const part of String(raw).split(',')) {
    const v = part.trim();
    if (!v) continue;
    try { out.push(new URL(v).hostname); } catch (e) { /* мусор в настройке игнорируем */ }
  }
  return out;
}

// Возвращает { ok, skipped, codes }.
//
// О поведении при сбое. Если ключ задан, а Cloudflare недоступен, проверка
// считается непройденной (fail closed). Обратный вариант — пропускать всех,
// когда проверяющий молчит — выглядит дружелюбнее, но защита, которую
// выключает недоступность чужого сервиса, защитой не является. Риск при этом
// невелик и заметен: атакующий не может вызвать сбой нашего исходящего
// запроса, а настоящая недоступность Cloudflare попадёт в журнал.
async function verifyTurnstile(token, remoteip, expectedAction) {
  if (!isEnabled()) return { ok: true, skipped: true };
  if (!token || typeof token !== 'string') {
    return { ok: false, skipped: false, codes: ['missing-input-response'] };
  }

  const body = new URLSearchParams();
  body.set('secret', secretKey());
  body.set('response', token);
  // Адрес передаётся, если он есть: Cloudflare использует его как
  // дополнительный сигнал, но проверка работает и без него.
  if (remoteip) body.set('remoteip', remoteip);

  let data;
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      // fetch без таймаута висит бесконечно, а этот вызов стоит на пути
      // регистрации — человек ждёт перед крутящейся кнопкой.
      signal: AbortSignal.timeout(10 * 1000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      console.error('turnstile: HTTP', res.status);
      return { ok: false, skipped: false, codes: ['http-' + res.status] };
    }
    data = await res.json();
  } catch (e) {
    console.error('turnstile: verification request failed:', e.message);
    return { ok: false, skipped: false, codes: ['request-failed'] };
  }

  if (!data.success) {
    // Коды Cloudflare полезны в журнале и бесполезны пользователю:
    // наружу уходит одно общее сообщение.
    console.warn('turnstile: rejected,', (data['error-codes'] || []).join(','));
    return { ok: false, skipped: false, codes: data['error-codes'] || [] };
  }

  // success:true — ещё не конец проверки. Ответ Cloudflare говорит, ГДЕ и НА
  // КАКОМ действии токен был выпущен, и это надо сверить: иначе токен,
  // полученный на чужом сайте с тем же публичным ключом или на соседней
  // форме, подойдёт сюда. Публичный ключ на то и публичный.
  const hosts = allowedHostnames();
  if (hosts.length && data.hostname && !hosts.includes(data.hostname)) {
    console.warn('turnstile: hostname mismatch:', data.hostname);
    return { ok: false, skipped: false, codes: ['hostname-mismatch'] };
  }
  if (expectedAction && data.action && data.action !== expectedAction) {
    console.warn('turnstile: action mismatch:', data.action, '!=', expectedAction);
    return { ok: false, skipped: false, codes: ['action-mismatch'] };
  }
  return { ok: true, skipped: false, codes: [] };
}

module.exports = { verifyTurnstile, isEnabled, siteKey };
