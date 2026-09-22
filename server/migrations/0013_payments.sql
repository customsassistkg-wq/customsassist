-- Оплаты подписки и постоянные расходы — учёт денег (22.09.2026).
--
-- Оплата проходит вне сервиса (перевод на карту, платёжное приложение, наличные):
-- администратор записывает её в админке, и запись сразу продлевает подписку на
-- оплаченные месяцы и ставит тариф помощника. Сумма, срок и способ нужны для
-- раздела «Экономика» дашборда (доход против расхода на API и сервер) и как
-- учётный документ. Данных карт сервис не получает. Адрес плательщика хранится
-- снимком: запись переживает удаление учётной записи (user_id обнуляется, как
-- в admin_audit_log), потому что учёт денег не может терять строки.
--
-- Постоянные расходы (сервер, домен, аккаунты магазинов) заполняет администратор
-- один раз; дашборд раскладывает их по месяцам (в год / 12, разово — в месяц оплаты).
--
-- Выкладывать до перезапуска API: routes/admin.js и routes/dash.js читают обе таблицы.

create table if not exists payments (
  id          bigserial primary key,
  user_id     uuid references users(id) on delete set null,
  email       text not null,
  amount      numeric(12,2) not null check (amount > 0),
  currency    text not null default 'KGS',
  plan        text check (plan in ('base', 'pro', 'max')),
  months      integer not null default 1 check (months between 1 and 24),
  paid_until  date,
  method      text,
  note        text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists payments_created_idx on payments(created_at desc);
create index if not exists payments_user_idx on payments(user_id);

create table if not exists expenses (
  id          bigserial primary key,
  name        text not null,
  amount      numeric(12,2) not null check (amount >= 0),
  currency    text not null default 'USD',
  period      text not null default 'month' check (period in ('month', 'year', 'once')),
  starts_on   date not null default current_date,
  ends_on     date,
  note        text,
  created_at  timestamptz not null default now()
);

-- Первые статьи — со слов владельца 22.09.2026; суммы уточняются по счетам в админке.
insert into expenses (name, amount, currency, period, starts_on, note) values
  ('Сервер Hetzner', 10, 'USD', 'month', '2026-09-01', 'около 10 $ в месяц по словам владельца; уточнить по счёту'),
  ('Домен customsassist.trade', 6, 'USD', 'year', '2026-09-01', '5–6 $ в год по словам владельца; уточнить дату и сумму по счёту регистратора');
