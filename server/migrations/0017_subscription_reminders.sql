-- Напоминания о сроке подписки (24.09.2026).
--
-- services/reminders.js раз в час ищет подписки, которые заканчиваются или закончились, и шлёт
-- письмо: за 3 дня, за день и после окончания (пробному доступу — только за день и после). Строка
-- здесь — отметка «это напоминание об этом сроке уже ушло»: вставка идёт до отправки, конфликт
-- ключа значит «уже отправлено», поэтому перезапуск сервера или второй процесс повторного письма
-- не дадут. Продление меняет срок — ключ новый, напоминания о новом сроке придут снова.
--
-- Удаляется вместе с учётной записью (on delete cascade) и через год (services/retention.js).
-- Названо в privacy.html. Выкладывать до перезапуска API.

create table if not exists subscription_reminders (
  user_id     uuid not null references users(id) on delete cascade,
  expires_on  date not null,
  kind        text not null check (kind in ('soon3', 'soon1', 'expired')),
  sent_at     timestamptz not null default now(),
  primary key (user_id, expires_on, kind)
);
