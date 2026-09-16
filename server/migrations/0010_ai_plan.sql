-- Тариф AI-ассистента: месячный лимит вопросов.
--
-- base — входит в подписку, 100 вопросов в месяц; pro — 300; max — 1000.
-- Сами числа живут в коде (routes/assistant.js, переопределяются AI_PLAN_LIMITS
-- в .env), в базе — только название тарифа: поменять лимит не значит мигрировать.
-- Администраторы лимита не имеют независимо от поля.

alter table users add column if not exists ai_plan text not null default 'base';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_ai_plan_check') then
    alter table users add constraint users_ai_plan_check check (ai_plan in ('base', 'pro', 'max'));
  end if;
end $$;
