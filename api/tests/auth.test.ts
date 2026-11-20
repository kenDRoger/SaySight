import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionCookie, createAuth, hashToken, magicLinkTtlMs, readCookie, serializeSessionCookie, sessionTtlMs, type AuthStore, type Role, type User, type TokenRecord } from '../src/auth.ts';

// In-memory store so token, expiry, and single-use rules can be tested directly.
function fakeStore() {
  const users = new Map<string, User>();
  const tokens = new Map<string, TokenRecord>();
  const sessions = new Map<string, { id: string; userId: string; expiresAt: number; revoked: boolean }>();
  const store: AuthStore = {
    async ensureUser(email, role: Role) {
      const found = [...users.values()].find((user) => user.email === email);
      if (found) return found;
      const user: User = { id: `user-${users.size + 1}`, email, role, status: 'active' };
      users.set(user.id, user);
      return user;
    },
    async findUser(id) { return users.get(id); },
    async createToken(record) { tokens.set(record.tokenHash, { ...record, consumedAt: null }); },
    async findToken(tokenHash) { return tokens.get(tokenHash); },
    async newestTokenCreatedAt(userId) {
      const times = [...tokens.values()].filter((token) => token.userId === userId).map((token) => token.expiresAt - magicLinkTtlMs);
      return times.length ? Math.max(...times) : undefined;
    },
    async consumeToken(id, at) {
      const token = [...tokens.values()].find((item) => item.id === id)!;
      if (token.consumedAt !== null) throw new Error('token_already_consumed');
      token.consumedAt = at;
    },
    async createSession(record) { sessions.set(record.tokenHash, { id: record.id, userId: record.userId, expiresAt: record.expiresAt, revoked: false }); },
    async findSession(tokenHash) {
      const found = sessions.get(tokenHash);
      return found && !found.revoked ? { id: found.id, userId: found.userId, expiresAt: found.expiresAt } : undefined;
    },
    async revokeSession(id) { const found = [...sessions.values()].find((item) => item.id === id); if (found) found.revoked = true; },
  };
  return { store, tokens };
}

function harness(options: { maintainerEmail?: string } = {}) {
  const { store, tokens } = fakeStore();
  const sent: Array<{ link: string; email: string }> = [];
  let clock = 1_000_000;
  const auth = createAuth(store, {
    maintainerEmail: options.maintainerEmail,
    baseUrl: 'http://app.test',
    now: () => clock,
    transport: (link, email) => sent.push({ link, email }),
  });
  return { auth, sent, tokens, advance: (ms: number) => { clock += ms; } };
}

test('magic link is hashed at rest and only ever travels through the transport', async () => {
  const { auth, sent, tokens } = harness();
  await auth.requestMagicLink('Citizen@Example.org');
  assert.equal(sent.length, 1);
  assert.match(sent[0].link, /^http:\/\/app\.test\/api\/v1\/auth\/verify\?token=/);
  const raw = sent[0].link.split('token=')[1];
  assert.equal([...tokens.keys()][0], hashToken(raw));
  assert.ok(![...tokens.keys()].includes(raw));
});

test('a magic link works once, then fails as invalid', async () => {
  const { auth, sent } = harness();
  await auth.requestMagicLink('once@example.org');
  const raw = sent[0].link.split('token=')[1];
  assert.ok(await auth.verify(raw));
  assert.equal(await auth.verify(raw), undefined);
});

test('an expired magic link is refused', async () => {
  const { auth, sent, advance } = harness();
  await auth.requestMagicLink('late@example.org');
  const raw = sent[0].link.split('token=')[1];
  advance(magicLinkTtlMs + 1);
  assert.equal(await auth.verify(raw), undefined);
});

test('an unknown address gets the same answer and no link', async () => {
  const { auth, sent } = harness();
  const result = await auth.requestMagicLink('nobody@example.org');
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
});

test('a repeat request inside the cooldown sends nothing', async () => {
  const { auth, sent } = harness();
  await auth.requestMagicLink('fast@example.org');
  await auth.requestMagicLink('fast@example.org');
  assert.equal(sent.length, 1);
});

test('the configured maintainer address becomes a maintainer on first sign-in', async () => {
  const { auth, sent } = harness({ maintainerEmail: 'Owner@Example.org' });
  await auth.requestMagicLink('owner@example.org');
  const verified = await auth.verify(sent[0].link.split('token=')[1]);
  assert.equal(verified?.user.role, 'maintainer');
});

test('any other address starts as a submitter', async () => {
  const { auth, sent } = harness({ maintainerEmail: 'owner@example.org' });
  await auth.requestMagicLink('person@example.org');
  const verified = await auth.verify(sent[0].link.split('token=')[1]);
  assert.equal(verified?.user.role, 'submitter');
});

test('an expired session no longer identifies the user', async () => {
  const { auth, sent, advance } = harness();
  await auth.requestMagicLink('session@example.org');
  const verified = await auth.verify(sent[0].link.split('token=')[1]);
  assert.ok(await auth.session(verified!.sessionToken));
  advance(sessionTtlMs + 1);
  assert.equal(await auth.session(verified!.sessionToken), undefined);
});

test('logging out revokes the session', async () => {
  const { auth, sent } = harness();
  await auth.requestMagicLink('leaving@example.org');
  const verified = await auth.verify(sent[0].link.split('token=')[1]);
  await auth.logout(verified!.sessionToken);
  assert.equal(await auth.session(verified!.sessionToken), undefined);
});

test('session cookies are httpOnly, lax, and cleared on logout', () => {
  const cookie = serializeSessionCookie('abc', true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.equal(readCookie(`a=1; saysight_session=abc%2B1; b=2`, 'saysight_session'), 'abc+1');
  assert.match(clearSessionCookie(false), /Max-Age=0/);
  assert.equal(readCookie(undefined, 'saysight_session'), undefined);
});
