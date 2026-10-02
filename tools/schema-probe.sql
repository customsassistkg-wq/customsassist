-- Структура базы одним списком строк (только устройство, без данных): столбцы, ограничения, индексы, расширения, триггеры.
-- Снимается с боевой базы и с базы, накатанной из миграций, и сравнивается построчно — так находят расхождение, которое
-- миграции не объясняют (ручную правку на сервере). Подробности и команды — tools/db-rehearsal.mjs и docs/backend-ops.md.
select 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, '') from information_schema.columns where table_schema = 'public' order by 1;
select 'con|' || conrelid::regclass::text || '|' || conname || '|' || contype::text || '|' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace order by 1;
select 'idx|' || tablename || '|' || indexname || '|' || indexdef from pg_indexes where schemaname = 'public' order by 1;
select 'ext|' || extname from pg_extension order by 1;
select 'trg|' || event_object_table || '|' || trigger_name from information_schema.triggers where trigger_schema = 'public' order by 1;
