// Thin wrapper over Resend's HTTP API (no SDK dependency needed — Node 18+
// has global fetch built in, and Resend's API is a single plain POST).
//
// RESEND_FROM_EMAIL should read «Customs Assist KG <noreply@customsassist.trade>».
// Its default here is Resend's shared sandbox sender, which delivers ONLY to
// the address the Resend account was signed up with — that is what silently
// swallowed every password-reset mail to real users until the domain was
// verified on 11.09.2026.
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    // fetch() has no default timeout, and this call is awaited by the
    // password-reset flow's background work — without a bound, one hung
    // connection keeps that work (and its DB client) alive indefinitely.
    signal: AbortSignal.timeout(15 * 1000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
  return res.json();
}

const BRAND = 'Customs Assist KG';

// Одна оболочка на все письма сервиса, чтобы они выглядели одинаково и
// чинились в одном месте.
//
// Три решения, каждое из которых легко сделать неправильно:
//  * вёрстка таблицами и inline-стилями — почтовые клиенты вырезают <style>
//    и не поддерживают flex/grid;
//  * логотип подключается по ссылке на сайт, а не вложением, но письмо
//    обязано читаться и БЕЗ него: Gmail и Outlook по умолчанию не грузят
//    удалённые картинки, поэтому под логотипом всегда есть текстовое имя;
//  * рядом с кнопкой печатается тот же адрес обычным текстом — если клиент
//    съест ссылку или её перепишет трекер, человек сможет скопировать руками.
function renderEmail({ title, intro, actionUrl, actionText, outro, footNote }) {
  const origin = (process.env.PUBLIC_ORIGIN
    || (process.env.APP_ORIGIN || '').split(',')[0]
    || '').trim().replace(/\/+$/, '');
  const logo = origin ? `${origin}/email-logo.jpg` : '';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#EEF1F6;font-family:Arial,Helvetica,sans-serif;color:#232A38">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:14px;border:1px solid #DCE1EB">
    <tr><td style="padding:26px 28px 0;text-align:center">
      ${logo ? `<img src="${logo}" alt="${BRAND}" width="220" style="display:block;margin:0 auto 10px;max-width:220px;height:auto;border:0">` : ''}
      <div style="font-size:15px;font-weight:bold;color:#232A38;letter-spacing:.2px">${BRAND}</div>
      <div style="font-size:12px;color:#5C6474;margin-top:2px">Таможенные данные &bull; ТН ВЭД &bull; Кыргызстан</div>
    </td></tr>
    <tr><td style="padding:22px 28px 0">
      <div style="font-size:18px;font-weight:bold;color:#171A21">${esc(title)}</div>
      <p style="font-size:14px;line-height:1.6;color:#3A4254;margin:12px 0 0">${intro}</p>
    </td></tr>
    ${actionUrl ? `<tr><td style="padding:22px 28px 0;text-align:center">
      <a href="${actionUrl}" style="display:inline-block;background:#3A46C8;color:#FFFFFF;text-decoration:none;font-size:14px;font-weight:bold;padding:13px 26px;border-radius:10px">${esc(actionText)}</a>
    </td></tr>
    <tr><td style="padding:14px 28px 0">
      <p style="font-size:12px;line-height:1.6;color:#5C6474;margin:0">Если кнопка не открывается, скопируйте ссылку в адресную строку браузера:<br>
        <span style="color:#3A46C8;word-break:break-all">${actionUrl}</span></p>
    </td></tr>` : ''}
    ${outro ? `<tr><td style="padding:18px 28px 0">
      <p style="font-size:13px;line-height:1.6;color:#3A4254;margin:0">${outro}</p></td></tr>` : ''}
    <tr><td style="padding:22px 28px 26px">
      <div style="border-top:1px solid #E5E9F0;padding-top:14px;font-size:11px;line-height:1.6;color:#7A8294">
        ${footNote ? `${footNote}<br><br>` : ''}
        ${BRAND} &copy; 2026${origin ? ` &bull; <a href="${origin}" style="color:#3A46C8;text-decoration:none">${origin.replace(/^https?:\/\//, '')}</a>` : ''}
      </div>
    </td></tr>
  </table>
</body></html>`;
}

module.exports = { sendEmail, renderEmail, BRAND };
