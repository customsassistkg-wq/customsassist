// node server/tests/static-assets.test.js
// Каждая ссылка страницы и манифеста на свой же файл (картинки, иконки, манифест)
// должна указывать на существующий файл, и его должен отдавать и nginx, и локальный
// Express. Ни один другой тест этого не видит: не найденная картинка — не ошибка
// страницы, браузерные тесты проходят с пустым фоном и сломанным логотипом.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Ссылки вида href="/x", src="/x", url(/x) — только свои, без внешних адресов и data:; и полные адреса своих файлов
// (content="https://customsassist.trade/assets/…" — картинка карточки ссылки, og:image, с 01.10.2026).
function refs(text) {
  const out = new Set();
  for (const re of [/(?:href|src)="(\/[^"#?]+)"/g, /url\((\/[^)#?]+)\)/g, /"src":\s*"(\/[^"#?]+)"/g,
    /(?:href|src|content)="https:\/\/customsassist\.trade(\/[^"#?]+\.\w+)"/g]) {
    let m;
    while ((m = re.exec(text))) out.add(m[1]);
  }
  return [...out];
}

const page = read('tnved_checker.html');
const manifest = read('manifest.webmanifest');
const all = new Map();
// server/dash/index.html — страница дашборда администраторов: отдаётся своим блоком nginx
// (dash.*), картинки берёт из того же /assets/ через alias.
for (const [file, text] of [['tnved_checker.html', page], ['manifest.webmanifest', manifest],
  ['privacy.html', read('privacy.html')], ['terms.html', read('terms.html')], ['server/dash/index.html', read('server/dash/index.html')]]) {
  for (const r of refs(text)) if (!all.has(r)) all.set(r, file);
}

// 1. Файл существует на диске по тому же пути, каким его увидит nginx (root /opt/tnved).
const missing = [...all].filter(([r]) => !fs.existsSync(path.join(ROOT, r.slice(1))));
assert.equal(missing.length, 0, 'нет файла для ссылок: ' + missing.map(([r, f]) => `${r} (${f})`).join(', '));

// 1а. Картинки — файлами, а не base64 в странице: до 01.10.2026 логотип подвала (PNG 420×420, показ 40×40)
// занимал 207 КБ из 481 КБ страницы, и каждый вход скачивал его заново. Остаётся только фавиконка
// (tools/build-logo.py, ~21 КБ).
const inline = [...page.matchAll(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g)].map((m) => m[0].length);
assert.ok(inline.reduce((a, b) => a + b, 0) <= 32 * 1024, `картинки base64 в странице: ${inline.join(' + ')} знаков — больше 32 КБ, вынесите в assets/`);
assert.ok(Buffer.byteLength(page) < 300 * 1024, `страница ${Buffer.byteLength(page)} байт: без картинок она меньше 300 КБ`);

// 2. Картинки лежат в assets/ — одна папка на все картинки сайта (см. CLAUDE.md).
const images = [...all.keys()].filter((r) => /\.(webp|png|jpe?g|svg|gif|ico)$/i.test(r));
assert.ok(images.length >= 12, 'ожидались ссылки на картинки, найдено ' + images.length);
const stray = images.filter((r) => !r.startsWith('/assets/'));
assert.equal(stray.length, 0, 'картинки вне assets/: ' + stray.join(', '));

// 3. Локальный Express (npm run dev, без nginx) отдаёт каждую такую ссылку.
const index = read('server/src/index.js');
const listedBlock = index.match(/app\.get\(\[([^\]]+)\]/);
assert.ok(listedBlock, 'в index.js не найден список публичных файлов');
const listed = new Set((listedBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)));
const servedByStatic = (r) => r.startsWith('/assets/') && !r.startsWith('/assets/source/');
const unserved = [...all.keys()].filter((r) => !servedByStatic(r) && !listed.has(r));
assert.equal(unserved.length, 0, 'не отдаётся локальным Express: ' + unserved.join(', '));
assert.match(index, /app\.use\('\/assets', express\.static/, 'нет раздачи /assets в index.js');
assert.match(index, /app\.use\('\/assets\/source'/, 'исходники логотипа должны быть закрыты');

// 4. Старые адреса остаются рабочими: на /icons/* ссылаются установленные копии
//    сайта и iOS, на /email-logo.jpg — уже отправленные письма.
const nginx = read('server/nginx.conf');
assert.match(nginx, /location \^~ \/icons\/ \{\s*alias \/opt\/tnved\/assets\/icons\/;/,
  'nginx должен отдавать старый /icons/ из assets/icons');
assert.match(nginx, /location = \/email-logo\.jpg \{\s*alias \/opt\/tnved\/assets\/email-logo\.jpg;/,
  'nginx должен отдавать старый /email-logo.jpg из assets');
assert.match(nginx, /location \^~ \/assets\/source\/ \{\s*return 404;/,
  'исходники логотипа не должны отдаваться наружу');
assert.match(index, /app\.get\('\/email-logo\.jpg'/, 'старый адрес логотипа писем нужен и в dev');

// 5. Запреты по регулярным выражениям (скрытые файлы, архивы, дампы, *.new) закрывают лишнее
//    и не закрывают ни одной настоящей ссылки сайта: потерянный «\» в «/\.» закрыл бы всё.
const deny = [...nginx.matchAll(/location (~\*?) (\S+) \{\s*return 404;/g)].map((m) => new RegExp(m[2], m[1] === '~*' ? 'i' : ''));
assert.equal(deny.length, 2, 'ожидались два запрета по регулярному выражению');
const denied = (p) => deny.some((re) => re.test(p));
for (const p of ['/.git/config', '/.env', '/backup.SQL', '/tnved_checker.html.new', '/db.dump', '/site.tar.gz', '/session.md', '/deploy.sh']) {
  assert.ok(denied(p), 'должен быть закрыт: ' + p);
}
const open = [...all.keys(), '/', '/tnved_checker.html', '/privacy.html', '/terms.html', '/ai-risk.json', '/manifest.webmanifest',
  '/.well-known/acme-challenge/token', '/api/checker.js', '/api/engine', '/api/auth/login', '/icons/icon-192.png', '/email-logo.jpg'];
assert.deepEqual(open.filter(denied), [], 'запрет закрыл настоящий адрес сайта');
assert.match(index, /app\.use\('\/icons', express\.static\(path\.join\(root, 'assets', 'icons'\)\)\)/,
  'старый /icons нужен и в dev');

// 5. Письма ссылаются на новый адрес — иначе новое письмо придёт с битой картинкой.
assert.match(read('server/src/services/email.js'), /\$\{origin\}\/assets\/email-logo\.jpg/,
  'письма должны брать логотип из assets/');

// 6. Исходники логотипа — вход генераторов, а не часть выдачи: лежат в assets/source
//    и не упоминаются ни на странице, ни в манифесте.
for (const f of ['logo_mark.png', 'logo_wide.png', 'logo_dark.png', 'logo_white.png', 'logo_dark1.png', 'logo_white1.png']) {
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'source', f)), 'нет исходника ' + f);
}
assert.ok(!/\/assets\/source\//.test(page + manifest), 'страница не должна ссылаться на исходники');

console.log(`PASS: ${all.size} ссылок на свои файлы, ${images.length} картинок — все в assets/; старые /icons и /email-logo.jpg отдаются`);
