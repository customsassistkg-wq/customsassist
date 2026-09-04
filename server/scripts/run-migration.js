// One-off helper to apply a single migrations/*.sql file by hand, the same
// way create-first-admin.js already connects (dotenv + the shared pool)
// without ever putting the connection string on the command line.
// Usage: node scripts/run-migration.js migrations/0002_subscription.sql
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/run-migration.js <path-to-migration.sql>');
    process.exit(1);
  }
  const sql = fs.readFileSync(path.resolve(file), 'utf8');
  await pool.query(sql);
  console.log('Applied:', file);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
