-- Журнал AI-помощника: вопрос, ответ, какие поиски сделала модель, расход
-- токенов и оценка пользователя (👍/👎).
--
-- Зачем: понять, о чём реально спрашивают и где помощник ошибается, — из
-- ответов с 👎 собирается контрольный набор вопросов (server/tests/
-- assistant-eval.js), — и видеть расход API по пользователям.
--
-- Хранится только текст переписки с помощником; поиск по сайту и калькулятор
-- по-прежнему не журналируются. Записи удаляются вместе с пользователем.

create table if not exists assistant_log (
  id            bigserial primary key,
  user_id       uuid not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  question      text not null,
  answer        text,
  searched      jsonb not null default '[]',
  unverified    jsonb not null default '[]',
  model         text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  duration_ms   integer not null default 0,
  error         text,
  rating        smallint check (rating in (-1, 1)),
  comment       text
);

create index if not exists assistant_log_user_created_idx on assistant_log(user_id, created_at desc);
create index if not exists assistant_log_created_idx on assistant_log(created_at desc);
