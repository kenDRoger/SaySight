import type { Pool } from 'pg';
import type { AuthStore, Role, User } from './auth.js';

// PostgreSQL-backed AuthStore. Accounts require a database: there is no in-memory
// fallback, because a session store that silently forgets itself would look like
// an authentication bypass.
export function createPgAuthStore(pool: Pool): AuthStore {
  const toUser = (row: { id: string; email: string; role: string; status: string }): User => ({
    id: row.id,
    email: row.email,
    role: row.role as Role,
    status: row.status === 'suspended' ? 'suspended' : 'active',
  });

  return {
    async ensureUser(email, role) {
      // The configured maintainer address is upgraded on first sight; every other
      // address keeps the role already stored.
      const inserted = await pool.query(
        `INSERT INTO users (id, email, role) VALUES (gen_random_uuid(), $1, $2)
         ON CONFLICT (lower(email)) DO NOTHING
         RETURNING id, email, role, status`,
        [email, role],
      );
      if (inserted.rows[0]) return toUser(inserted.rows[0]);
      if (role === 'maintainer') {
        await pool.query(`UPDATE users SET role = 'maintainer' WHERE lower(email) = $1 AND role <> 'maintainer'`, [email]);
      }
      const existing = await pool.query('SELECT id, email, role, status FROM users WHERE lower(email) = $1', [email]);
      return toUser(existing.rows[0]);
    },

    async findUser(id) {
      const result = await pool.query('SELECT id, email, role, status FROM users WHERE id = $1', [id]);
      return result.rows[0] ? toUser(result.rows[0]) : undefined;
    },

    async createToken({ id, userId, tokenHash, expiresAt }) {
      await pool.query('INSERT INTO auth_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [id, userId, tokenHash, new Date(expiresAt)]);
    },

    async findToken(tokenHash) {
      const result = await pool.query('SELECT id, user_id, token_hash, expires_at, consumed_at FROM auth_tokens WHERE token_hash = $1', [tokenHash]);
      const row = result.rows[0];
      return row ? { id: row.id, userId: row.user_id, tokenHash: row.token_hash, expiresAt: Number(row.expires_at), consumedAt: row.consumed_at ? Number(row.consumed_at) : null } : undefined;
    },

    async newestTokenCreatedAt(userId) {
      const result = await pool.query('SELECT max(created_at) AS newest FROM auth_tokens WHERE user_id = $1', [userId]);
      return result.rows[0]?.newest ? Number(result.rows[0].newest) : undefined;
    },

    async consumeToken(id, at) {
      // Conditional update, so two concurrent verifies cannot both win.
      const result = await pool.query('UPDATE auth_tokens SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id', [id, new Date(at)]);
      if (!result.rows[0]) throw new Error('token_already_consumed');
    },

    async createSession({ id, userId, tokenHash, expiresAt }) {
      await pool.query('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [id, userId, tokenHash, new Date(expiresAt)]);
    },

    async findSession(tokenHash) {
      const result = await pool.query('SELECT id, user_id, expires_at, revoked_at FROM sessions WHERE token_hash = $1', [tokenHash]);
      const row = result.rows[0];
      if (!row || row.revoked_at) return undefined;
      return { id: row.id, userId: row.user_id, expiresAt: Number(row.expires_at) };
    },

    async revokeSession(id, at) {
      await pool.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, new Date(at)]);
    },
  };
}
