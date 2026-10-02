// Уведомление об изменении правил использования (01.10.2026).
//
// Закон: об изменении пользовательского соглашения поставщик уведомляет пользователя любым доступным способом и
// устанавливает срок не менее одного месяца (ч. 5 ст. 114 Цифрового кодекса КР от 31.07.2025 № 178). Правила сервиса
// (раздел «Изменение правил») обещают уведомление «на сайте или по электронной почте». Этот модуль — «на сайте»:
// пока не наступил день вступления, страница входа (GET /api/auth/config) и приложение (ответы входа и GET /api/auth/me)
// показывают блок «С такого-то числа вступает в силу новая редакция правил — прочитать», а в журнале администрирования
// остаётся запись, что вошедшему пользователю уведомление показано (action terms_notice, via banner) — чтобы потом
// можно было ответить, кого и когда предупредили. По почте — scripts/notify-terms.js (тоже terms_notice, via
// scripts/notify-terms.js): два способа независимы, запись одного не отменяет письма.
//
// Что показывать — константа ниже: изменение уведомления попадает в историю git вместе с датой, поэтому видно, что и
// когда было объявлено. Для проверки и срочной правки без выкладки переопределяется TERMS_NOTICE в .env (тот же JSON).
// Как только день вступления наступил (по Бишкеку), блок исчезает сам — дальше работает окно «Принимаю» (TERMS_VERSION).
// Редакция от 01.10.2026 вступила в силу 03.11.2026, страница terms-next.html убрана: встроенного уведомления нет (null).
// Следующую редакцию объявляют так: { effective: 'ГГГГ-ММ-ДД', url: '/terms-next.html', text: '…' } и страница с её текстом (docs/launch.md).
const NOTICE = null;

const bishkekDay = (now) => new Date(now + 6 * 3600e3).toISOString().slice(0, 10);

function raw() {
  if (process.env.TERMS_NOTICE !== undefined) {
    if (!process.env.TERMS_NOTICE.trim()) return null; // TERMS_NOTICE= — уведомление выключено
    try { return JSON.parse(process.env.TERMS_NOTICE); } catch (e) { return null; }
  }
  return NOTICE;
}

// { effective, url, text } или null: не задано, задано неверно или день вступления уже наступил.
// Ссылка — только путь на нашем сайте («/…», не «//…»): в браузер она попадает как есть.
function current(now = Date.now()) {
  const n = raw();
  if (!n || typeof n !== 'object') return null;
  if (!/^\d{4}-\d\d-\d\d$/.test(String(n.effective || ''))) return null;
  if (typeof n.text !== 'string' || !n.text.trim()) return null;
  if (typeof n.url !== 'string' || !/^\/[^/\\]/.test(n.url)) return null;
  if (bishkekDay(now) >= n.effective) return null;
  return { effective: n.effective, url: n.url, text: n.text.trim().slice(0, 300) };
}

// Записать, что вошедшему пользователю показано уведомление: не чаще раза за сеанс и раз на пользователя и дату
// вступления (insert … where not exists). Сбой записи не мешает ответу.
function recordShown(pool, session, user, n) {
  if (!n || !user || !user.id) return;
  if (session) {
    if (session.termsNoticeAt === n.effective) return;
    session.termsNoticeAt = n.effective;
  }
  pool.query(
    `insert into admin_audit_log (actor_id, action, target_user_id, detail)
     select null, 'terms_notice', $1::uuid, $2::jsonb
     where not exists (select 1 from admin_audit_log where action = 'terms_notice' and target_user_id = $1::uuid
       and detail->>'effective' = $3::text and detail->>'via' = 'banner')`,
    [user.id, JSON.stringify({ email: user.email, effective: n.effective, url: n.url, via: 'banner' }), n.effective]
  ).catch((err) => console.error('terms notice record failed:', err.message));
}

module.exports = { current, recordShown, NOTICE };
