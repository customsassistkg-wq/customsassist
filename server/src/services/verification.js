const crypto = require('crypto');
const { pool } = require('../db');
const { sendEmail, renderEmail } = require('./email');
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFY_RESEND_COOLDOWN_MS = 2 * 60 * 1000;
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function publicOrigin() { return (process.env.PUBLIC_ORIGIN || (process.env.APP_ORIGIN || '').split(',')[0]).trim().replace(/\/+$/, ''); }

async function issueVerification(user) {
  const { rows: recent } = await pool.query(
    `select 1 from email_verification_tokens
      where user_id=$1 and used_at is null and expires_at>now()
        and created_at>now()-make_interval(secs=>$2::double precision)
      limit 1`,
    [user.id, VERIFY_RESEND_COOLDOWN_MS / 1000]
  );
  if (recent[0]) return { skipped: 'cooldown' };

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'insert into email_verification_tokens (user_id, token_hash, expires_at) values ($1,$2,$3)',
    [user.id, hashToken(token), new Date(Date.now() + VERIFY_TOKEN_TTL_MS)]
  );
  const url = `${publicOrigin()}/?verify=${token}`;
  await sendEmail({
    to: user.email,
    subject: 'Подтвердите адрес почты — Customs Assist KG',
    html: renderEmail({
      title: 'Подтвердите адрес почты',
      intro: 'Вы зарегистрировались в Customs Assist KG — сервисе проверки кодов ТН ВЭД Кыргызской Республики и ЕАЭС. Остался один шаг: подтвердите, что этот адрес ваш.',
      actionUrl: url,
      actionText: 'Подтвердить адрес',
      outro: 'Ссылка действительна 24 часа. Без подтверждения вход в сервис недоступен — это защищает вас от регистрации на ваш адрес посторонними.',
      footNote: 'Если вы не регистрировались в Customs Assist KG, просто не открывайте ссылку — учётная запись останется неподтверждённой.',
    }),
  });
  return { sent: true };
}
module.exports = { issueVerification };
