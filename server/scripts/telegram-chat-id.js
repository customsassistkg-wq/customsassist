// Настройка уведомлений в Telegram (services/telegram.js).
//
// 1. В @BotFather создайте бота (/newbot), токен — в .env: TELEGRAM_BOT_TOKEN=...
// 2. Каждый администратор открывает бота и нажимает «Старт» (или пишет ему что угодно).
// 3. node scripts/telegram-chat-id.js — покажет chat id всех, кто написал боту за последние сутки;
//    нужные — в .env через запятую: TELEGRAM_ADMIN_CHAT_IDS=123,456, затем systemctl restart tnved.
// 4. node scripts/telegram-chat-id.js --test — пробное сообщение на TELEGRAM_ADMIN_CHAT_IDS.
//
// Скрипт только читает обновления бота (getUpdates) и ничего не хранит. getUpdates работает,
// пока у бота нет webhook; сервис webhook не ставит.
require('dotenv').config();
require('node:dns').setDefaultResultOrder('ipv4first');
const telegram = require('../src/services/telegram');

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  if (process.argv.includes('--test')) {
    if (!telegram.chatIds().length) throw new Error('TELEGRAM_ADMIN_CHAT_IDS не задан в .env');
    const n = await telegram.notifyAdmins('✅ <b>Customs Assist KG</b>\nУведомления администраторам подключены.');
    console.log(`отправлено: ${n} из ${telegram.chatIds().length}`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ответил: ${j.description || res.status}`);
  const seen = new Map();
  for (const u of j.result || []) {
    const m = u.message || u.edited_message || u.my_chat_member;
    if (!m || !m.chat) continue;
    const c = m.chat;
    seen.set(c.id, [c.type, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || '', c.username ? '@' + c.username : ''].join('  '));
  }
  if (!seen.size) { console.log('Никто не писал боту за последние сутки: откройте бота в Telegram, нажмите «Старт» и запустите снова.'); return; }
  console.log('chat id — тип, имя, username:');
  for (const [id, info] of seen) console.log(`${id}  ${info}`);
  console.log(`\nВ .env: TELEGRAM_ADMIN_CHAT_IDS=${[...seen.keys()].join(',')}  (оставьте только своих)`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
