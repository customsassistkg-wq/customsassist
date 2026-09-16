-- Стоимость вопросов к AI-помощнику — для счёта по пользователям.
--
-- DeepSeek берёт за три вида токенов по-разному: вход из кэша (в 50 раз дешевле),
-- вход без кэша и выход, а в часы пик — вдвое дороже. input_tokens из 0008 —
-- только вход без кэша: кэш API отдаёт отдельно (cache_read_input_tokens), и его
-- не записывали. Стоимость считается по каждому раунду в момент вызова и
-- хранится готовой: цены меняются, пересчитывать прошлые месяцы по новым нельзя.

alter table assistant_log add column if not exists cache_read_tokens integer not null default 0;
alter table assistant_log add column if not exists cost_usd numeric(12, 6) not null default 0;

-- Записи до этой миграции (16.09.2026, первые вопросы) — без данных о кэше:
-- оценка сверху по пиковым ценам deepseek-flash на 16.09.2026 (вход 0,30 $, выход 1,20 $ за 1 млн).
update assistant_log
   set cost_usd = input_tokens * 0.30 / 1e6 + output_tokens * 1.20 / 1e6
 where cost_usd = 0 and (input_tokens > 0 or output_tokens > 0);

-- Индекс по месяцу не нужен: отчёт фильтрует created_at диапазоном, и индекс
-- (user_id, created_at desc) из 0008 для этого подходит.
