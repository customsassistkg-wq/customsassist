// Запуск браузера для браузерных тестов (не тест сам по себе).
//
// PLAYWRIGHT_MODULE — путь к установленному playwright-core; без него браузерные части печатают SKIP.
// PLAYWRIGHT_CHANNEL — какой браузер: по умолчанию msedge (машина владельца, Windows, Edge установлен);
// пустое значение — Chromium самого Playwright (Linux, облако: node <playwright-core>/cli.js install
// chromium-headless-shell), chrome — установленный Chrome. До 01.10.2026 канал msedge был вписан в каждый
// тест, и на машине без Edge браузерные части не запускались вовсе.
function launch(options = {}) {
  const playwright = require(process.env.PLAYWRIGHT_MODULE);
  const channel = process.env.PLAYWRIGHT_CHANNEL === undefined ? 'msedge' : process.env.PLAYWRIGHT_CHANNEL;
  return playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}), ...options });
}

module.exports = { launch };
