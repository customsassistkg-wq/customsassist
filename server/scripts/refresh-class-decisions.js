require('dotenv').config();
const { refresh } = require('../src/services/classDecisions');

refresh()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
