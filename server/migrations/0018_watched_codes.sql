-- «Мои коды»: слежение за изменениями по кодам ТН ВЭД (24.09.2026).
--
-- Пользователь отмечает 10-значные коды ЕТТ (не больше 30). Раз в сутки services/watch.js
-- строит по каждому коду слепок существенного — какие карточки есть (тип, направление,
-- признаки, заголовок), их метки и ставку пошлины — и сравнивает с сохранённым. Подробности
-- карточек и отметки о сверке источника в слепок не входят: иначе правка формулировки или
-- новая сверка присылали бы «изменения», которых по существу нет. Проверено 24.09.2026 на
-- 1 682 кодах: между соседними днями слепок не меняется ни у одного, через месяц — у 5 (меры
-- со сроками). Изменение уходит пользователю письмом и сохраняется новым слепком.
--
-- Строка — личный выбор пользователя; удаляется вместе с учётной записью. Названо в privacy.html.
-- Выкладывать до перезапуска API: routes/watch.js и services/watch.js читают эту таблицу.

create table if not exists watched_codes (
  user_id     uuid not null references users(id) on delete cascade,
  code        text not null check (code ~ '^[0-9]{10}$'),
  snapshot    jsonb,
  checked_on  date,
  changed_at  timestamptz,
  created_at  timestamptz not null default now(),
  primary key (user_id, code)
);
create index if not exists watched_codes_code_idx on watched_codes(code);
