// Webhook бота: куда Telegram шлёт сообщения администраторов боту (routes/ops.js, /api/ops/telegram).
//
//   node scripts/telegram-webhook.js set     — поставить: адрес из APP_ORIGIN (первый), секрет —
//                                              TELEGRAM_WEBHOOK_SECRET (Telegram шлёт его в заголовке)
//   node scripts/telegram-webhook.js info    — что стоит сейчас и последние ошибки доставки
//   node scripts/telegram-webhook.js delete  — снять (нужно для scripts/telegram-chat-id.js:
//                                              пока стоит webhook, getUpdates не работает)
// Токен бота в адресе запроса — в вывод он не попадает.
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const api = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000),
}).then((r) => r.json());

(async () => {
  if (!token) { console.error('нет TELEGRAM_BOT_TOKEN в .env'); process.exit(1); }
  const cmd = process.argv[2] || 'info';
  if (cmd === 'set') {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) { console.error('TELEGRAM_WEBHOOK_SECRET: 32–256 знаков A-Z a-z 0-9 _ -'); process.exit(1); }
    const origin = String(process.env.APP_ORIGIN || '').split(',')[0].trim().replace(/\/+$/, '');
    if (!/^https:\/\//.test(origin)) { console.error('APP_ORIGIN должен начинаться с https://'); process.exit(1); }
    const r = await api('setWebhook', { url: origin + '/api/ops/telegram', secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
    console.log(r.ok ? `webhook: ${origin}/api/ops/telegram` : `ошибка: ${r.description}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'delete') {
    const r = await api('deleteWebhook', { drop_pending_updates: false });
    console.log(r.ok ? 'webhook снят' : `ошибка: ${r.description}`);
    process.exit(r.ok ? 0 : 1);
  }
  const r = await api('getWebhookInfo');
  const i = r.result || {};
  console.log(JSON.stringify({ url: i.url || '', pending: i.pending_update_count, last_error: i.last_error_message || null, last_error_at: i.last_error_date ? new Date(i.last_error_date * 1000).toISOString() : null, allowed_updates: i.allowed_updates }, null, 1));
})().catch((err) => { console.error(err.message); process.exit(1); });
