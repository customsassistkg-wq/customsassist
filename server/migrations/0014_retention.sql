-- Сроки хранения из privacy.html исполняются, а не только названы (22.09.2026).
--
-- Журнал административных действий хранится три года после удаления учётной записи
-- (столько же — запись о принятии правил, ч. 4 ст. 114 Цифрового кодекса). При удалении
-- target_user_id обнуляется (миграция 0003), и строка теряет связь с учётной записью:
-- адрес есть не во всех (set_role, set_subscription, disable_user его не пишут). Поэтому
-- срок ставится в саму строку в момент удаления (routes/admin.js), а раз в сутки
-- services/retention.js удаляет строки с истёкшим сроком.
--
-- Строки, осиротевшие до этой миграции (11 удалений 11–12.09.2026), получают срок от
-- удаления с тем же адресом, а без адреса — от последнего удаления: все они были в
-- течение суток, так что ошибка не больше суток. Статьи расходов (expense_*) — дело
-- администратора, а не пользователя, срока не получают.
alter table admin_audit_log add column if not exists purge_after timestamptz;

update admin_audit_log a
   set purge_after = coalesce(
         (select min(d.created_at) from admin_audit_log d
           where d.action = 'delete_user' and d.detail->>'email' = a.detail->>'email' and d.created_at >= a.created_at),
         (select max(created_at) from admin_audit_log where action = 'delete_user')
       ) + interval '3 years'
 where a.target_user_id is null
   and a.action not in ('expense_add', 'expense_delete')
   and a.purge_after is null;
