// Grants a role to an existing account. Roles are never assignable through the
// public API, so promoting a reviewer is an operator action.
import { Pool } from 'pg';

const [email, role] = process.argv.slice(2);
const roles = new Set(['submitter', 'reviewer', 'maintainer']);

if (!email || !role || !roles.has(role)) {
  console.error('usage: node scripts/promote.mjs <email> <submitter|reviewer|maintainer>');
  process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://saysight:saysight@localhost:5432/saysight' });
try {
  const result = await pool.query('UPDATE users SET role = $2 WHERE lower(email) = lower($1) RETURNING email, role', [email, role]);
  if (!result.rows[0]) {
    console.error(`no account for ${email}; sign in once, then promote`);
    process.exit(1);
  }
  console.log(`promoted ${result.rows[0].email} to ${result.rows[0].role}`);
} finally {
  await pool.end();
}
