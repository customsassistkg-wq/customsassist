require('dotenv').config();
// Как в src/index.js: IPv6 на сервере прописан, но не работает, и без этой строки запрос
// сначала ждёт таймаута по AAAA. Скрипты запускаются отдельным процессом и index.js не читают.
require('node:dns').setDefaultResultOrder('ipv4first');
const { refresh } = require('../src/services/classDecisions');

refresh()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
