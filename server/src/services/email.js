// Thin wrapper over Resend's HTTP API (no SDK dependency needed — Node 18+
// has global fetch built in, and Resend's API is a single plain POST).
// RESEND_FROM_EMAIL defaults to Resend's shared sandbox sender, which can
// only deliver to the email address the Resend account itself was signed
// up with, until a real domain is added and verified at resend.com/domains
// — see session.md for the current status of that.
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

module.exports = { sendEmail };
