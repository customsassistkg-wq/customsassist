// node tools/smtp-probe.js <mx-host> <address> [...]
// Спрашивает почтовый сервер, примет ли он письмо для адреса, и заканчивает разговор до DATA —
// письмо не отправляется. 250 на RCPT — адрес принимается (Cloudflare пишет «250 2.1.0 Ok»), 550 5.1.1 — нет (правило пересылки не
// создано, выключено или адрес-получатель в Cloudflare не подтверждён). Запускать с рабочей машины:
// Hetzner закрывает исходящий порт 25, с сервера соединение не установится.
const net = require('net'), tls = require('tls');
const host = process.argv[2] || 'route1.mx.cloudflare.net';
const rcpts = process.argv.slice(3);
let sock = net.connect(25, host), buf = '', waiters = [];
const onData = (d) => { buf += d.toString(); let i; while ((i = buf.search(/\r?\n/)) >= 0) { const line = buf.slice(0, i); buf = buf.slice(buf.indexOf('\n') + 1); if (/^\d{3} /.test(line)) { const w = waiters.shift(); if (w) w(line); } } };
sock.on('data', onData);
const reply = () => new Promise((r) => waiters.push(r));
const send = async (cmd) => { sock.write(cmd + '\r\n'); const r = await reply(); console.log('> ' + cmd + '\n< ' + r); return r; };
(async () => {
  console.log('< ' + await reply());
  let r = await send('EHLO probe.customsassist.trade');
  r = await send('STARTTLS');
  if (r.startsWith('220')) {
    sock.removeListener('data', onData);
    sock = tls.connect({ socket: sock, servername: host });
    sock.on('data', onData);
    await new Promise((res) => sock.once('secureConnect', res));
    await send('EHLO probe.customsassist.trade');
  }
  await send('MAIL FROM:<>');
  for (const a of rcpts) await send('RCPT TO:<' + a + '>');
  await send('QUIT');
  sock.end();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 40000);
