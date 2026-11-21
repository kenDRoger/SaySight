// Demo-only endpoint contract: with SAYSIGHT_DEMO_ROLES unset the route must not exist,
// and with it set it must grant exactly the three roles and nothing else. This file
// spawns its own server because the flag is read once at startup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = 'postgres://saysight:saysight-dev-only@localhost:5432/saysight';

const freePort = () => new Promise<number>((resolvePort) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    server.close(() => resolvePort(port));
  });
});

const tcpReachable = async (host: string, port: number): Promise<boolean> => new Promise((resolveReachable) => {
  const socket = new Socket();
  socket.setTimeout(500);
  socket.once('connect', () => { socket.destroy(); resolveReachable(true); });
  socket.once('timeout', () => { socket.destroy(); resolveReachable(false); });
  socket.once('error', () => resolveReachable(false));
  socket.connect(port, host);
});

let child: ChildProcess | undefined;
let baseUrl = '';
let databaseReachable = false;

const startApi = async (demoRoles: boolean) => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, COOKIE_SECURE: 'false', SAYSIGHT_BASE_URL: baseUrl };
  if (demoRoles) env.SAYSIGHT_DEMO_ROLES = '1'; else delete env.SAYSIGHT_DEMO_ROLES;
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error('the demo test API did not start');
};

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('demo role switching is closed by default and opens exactly three roles when enabled', async (t) => {
  databaseReachable = await tcpReachable('localhost', 5432);
  if (!databaseReachable) { t.skip('PostgreSQL is not reachable'); return; }
  try {
    // Flag off: the route must not be reachable at all.
    await startApi(false);
    assert.equal((await post('/api/v1/auth/demo-session', { role: 'maintainer' })).status, 404);
    child?.kill();

    // Flag on: each role gets a working session, and nothing else does.
    await startApi(true);
    assert.equal((await post('/api/v1/auth/demo-session', { role: 'owner' })).status, 400);

    const reviewer = await post('/api/v1/auth/demo-session', { role: 'reviewer' });
    assert.equal(reviewer.status, 201, await reviewer.clone().text());
    const reviewerCookie = (reviewer.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(reviewerCookie, /^saysight_session=/);
    const reviewerBody = await reviewer.json() as { user: { id: string; role: string } };
    assert.equal(reviewerBody.user.role, 'reviewer');

    const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie: reviewerCookie } });
    const meBody = await me.json() as { user: { id: string; role: string }; demo: boolean };
    assert.equal(meBody.user.role, 'reviewer');
    assert.equal(meBody.demo, true);

    const maintainer = await post('/api/v1/auth/demo-session', { role: 'maintainer' });
    const maintainerCookie = (maintainer.headers.get('set-cookie') ?? '').split(';')[0];
    const maintainerBody = await maintainer.json() as { user: { id: string; role: string } };
    assert.equal(maintainerBody.user.role, 'maintainer');
    assert.notEqual(maintainerBody.user.id, reviewerBody.user.id, 'a role switch must be a different identity');

    // The guards are untouched: a reviewer session reaches the queue, and the sessions
    // are real ones the rest of the API accepts.
    const queue = await fetch(`${baseUrl}/api/v1/review/queue`, { headers: { cookie: reviewerCookie } });
    assert.equal(queue.status, 200, await queue.text());

    const submitter = await post('/api/v1/auth/demo-session', { role: 'submitter' });
    const submitterCookie = (submitter.headers.get('set-cookie') ?? '').split(';')[0];
    const denied = await fetch(`${baseUrl}/api/v1/review/queue`, { headers: { cookie: submitterCookie } });
    assert.equal(denied.status, 403, await denied.text());
  } finally {
    child?.kill();
  }
});
