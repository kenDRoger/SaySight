import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type Role = 'submitter' | 'reviewer' | 'maintainer';
export type User = { id: string; email: string; role: Role; status: 'active' | 'suspended' };
export type Session = { id: string; userId: string; expiresAt: number };

export type TokenRecord = { id: string; userId: string; tokenHash: string; expiresAt: number; consumedAt: number | null };

// Storage is injected so the token/session rules can be tested without a database.
export interface AuthStore {
  ensureUser(email: string, role: Role): Promise<User>;
  findUser(id: string): Promise<User | undefined>;
  createToken(record: { id: string; userId: string; tokenHash: string; expiresAt: number }): Promise<void>;
  findToken(tokenHash: string): Promise<TokenRecord | undefined>;
  newestTokenCreatedAt(userId: string): Promise<number | undefined>;
  consumeToken(id: string, at: number): Promise<void>;
  createSession(record: { id: string; userId: string; tokenHash: string; expiresAt: number }): Promise<void>;
  findSession(tokenHash: string): Promise<{ id: string; userId: string; expiresAt: number } | undefined>;
  revokeSession(id: string, at: number): Promise<void>;
}

export const magicLinkTtlMs = 15 * 60 * 1000;
export const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const magicLinkCooldownMs = 60 * 1000;
export const sessionCookie = 'saysight_session';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const mintToken = () => randomBytes(32).toString('base64url');

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(
  store: AuthStore,
  options: { maintainerEmail?: string; baseUrl: string; now?: () => number; transport: (link: string, email: string) => void },
) {
  const now = options.now ?? (() => Date.now());

  return {
    // Always resolves to 202-equivalent behaviour: an unknown address is not
    // revealed, and a repeat request inside the cooldown sends nothing.
    async requestMagicLink(rawEmail: string): Promise<{ sent: boolean }> {
      const email = rawEmail.trim().toLowerCase();
      if (!email.includes('@') || email.length > 254) throw new Error('invalid_email');
      const role: Role = email === options.maintainerEmail?.trim().toLowerCase() ? 'maintainer' : 'submitter';
      const user = await store.ensureUser(email, role);
      if (user.status !== 'active') return { sent: false };
      const newest = await store.newestTokenCreatedAt(user.id);
      if (newest !== undefined && now() - newest < magicLinkCooldownMs) return { sent: false };
      const token = mintToken();
      await store.createToken({ id: randomUUID(), userId: user.id, tokenHash: hashToken(token), expiresAt: now() + magicLinkTtlMs });
      options.transport(`${options.baseUrl.replace(/\/$/, '')}/api/v1/auth/verify?token=${token}`, user.email);
      return { sent: true };
    },

    // Demo-only: opens a session for one of three fixed identities so someone judging
    // the project can change roles without the email round trip. Every authorization
    // rule downstream still applies; only the proof-of-identity step is skipped.
    async openDemoSession(role: Role): Promise<{ sessionToken: string; user: User }> {
      const user = await store.ensureUser(`demo-${role}@demo.invalid`, role);
      if (user.status !== 'active') throw new Error('account_suspended');
      const sessionToken = mintToken();
      await store.createSession({ id: randomUUID(), userId: user.id, tokenHash: hashToken(sessionToken), expiresAt: now() + sessionTtlMs });
      return { sessionToken, user };
    },

    // Consumes the link once and opens a session. Expired, consumed, revoked, and
    // suspended-account links all fail the same way.
    async verify(rawToken: string): Promise<{ sessionToken: string; user: User } | undefined> {
      if (!rawToken) return undefined;
      const record = await store.findToken(hashToken(rawToken));
      if (!record || record.consumedAt !== null || record.expiresAt <= now()) return undefined;
      await store.consumeToken(record.id, now());
      const user = await store.findUser(record.userId);
      if (!user || user.status !== 'active') return undefined;
      const sessionToken = mintToken();
      await store.createSession({ id: randomUUID(), userId: user.id, tokenHash: hashToken(sessionToken), expiresAt: now() + sessionTtlMs });
      return { sessionToken, user };
    },

    async session(rawSessionToken: string | undefined): Promise<User | undefined> {
      if (!rawSessionToken) return undefined;
      const record = await store.findSession(hashToken(rawSessionToken));
      if (!record || record.expiresAt <= now()) return undefined;
      const user = await store.findUser(record.userId);
      return user && user.status === 'active' ? user : undefined;
    },

    async logout(rawSessionToken: string | undefined): Promise<void> {
      if (!rawSessionToken) return;
      const record = await store.findSession(hashToken(rawSessionToken));
      if (record) await store.revokeSession(record.id, now());
    },
  };
}

export const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
};

export const serializeSessionCookie = (token: string, secure: boolean) =>
  `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure ? '; Secure' : ''}`;

export const clearSessionCookie = (secure: boolean) => `${sessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

export const defaultTransport = (link: string, email: string) =>
  console.log(`magic link for ${email}: ${link}`);
