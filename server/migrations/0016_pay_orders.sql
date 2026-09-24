-- Заказы на оплату подписки по QR через xPay (24.09.2026).
--
-- Пользователь выбирает тариф и число месяцев, сервер считает сумму по своей цене
-- (routes/assistant.js, PLANS) и создаёт у xPay динамический QR на неё. Оплату засчитывает
-- только сервер, спросив xPay о статусе сам (routes/pay.js, settle): COMPLETED и сумма ровно
-- как в заказе. Засчитанный заказ пишет строку в payments (как ручная запись администратора)
-- и продлевает подписку; status меняется с 'waiting' один раз, поэтому повтор ничего не делает.
--
-- xPay получает только сумму, номер заказа и название тарифа — не адрес и не имя пользователя.
-- Строка заказа — рабочая: учёт денег остаётся в payments (номер операции xPay — в note),
-- заказы удаляются через 90 дней (services/retention.js). Названо в privacy.html.
--
-- Выкладывать до перезапуска API: routes/pay.js читает эту таблицу.

create table if not exists pay_orders (
  id                 bigserial primary key,
  user_id            uuid references users(id) on delete set null,
  email              text not null,
  plan               text not null check (plan in ('base', 'pro', 'max')),
  months             integer not null check (months between 1 and 12),
  amount             numeric(12,2) not null check (amount > 0),
  status             text not null default 'waiting' check (status in ('waiting', 'paid', 'failed', 'mismatch')),
  qr_transaction_id  text unique,
  qr_code            text,
  qr_image           text,
  xpay_status        text,
  payable            numeric(12,2),
  payment_id         bigint references payments(id) on delete set null,
  created_at         timestamptz not null default now(),
  paid_at            timestamptz
);
create index if not exists pay_orders_user_idx on pay_orders(user_id, created_at desc);
create index if not exists pay_orders_waiting_idx on pay_orders(created_at) where status = 'waiting';
