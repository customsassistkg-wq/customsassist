// One-off bootstrap script: creates (or promotes) the first admin account.
// Run once at deploy time, since only an existing admin can otherwise
// create accounts via the API.
//
// Usage: node scripts/create-first-admin.js <email> <password>
require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('../src/db');

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/create-first-admin.js <email> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `insert into users (email, password_hash, role)
     values ($1,$2,'admin')
     on conflict (email) do update set role='admin', password_hash=excluded.password_hash
     returning id, email, role`,
    [email.toLowerCase(), hash]
  );
  console.log('Admin ready:', rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
