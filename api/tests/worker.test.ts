import test from 'node:test';
import assert from 'node:assert/strict';
import { workerFetch } from '../src/worker.ts';

function flakyFetch(failures: number) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls <= failures) throw new TypeError('fetch failed');
    return new Response('{"ok":true}', { status: 200 });
  };
  return { impl, calls: () => calls };
}

test('retries once when the worker socket is dead', async () => {
  const fake = flakyFetch(1);
  const response = await workerFetch('http://worker/analyze', { method: 'POST', body: '{}' }, 2, fake.impl as typeof fetch);
  assert.equal(response.status, 200);
  assert.equal(fake.calls(), 2);
});

test('gives up after the attempt budget', async () => {
  const fake = flakyFetch(5);
  await assert.rejects(
    () => workerFetch('http://worker/analyze', { method: 'POST', body: '{}' }, 2, fake.impl as typeof fetch),
    /fetch failed/,
  );
  assert.equal(fake.calls(), 2);
});

test('does not retry a worker response that already answered', async () => {
  const fake = flakyFetch(0);
  const response = await workerFetch('http://worker/analyze', { method: 'POST', body: '{}' }, 2, fake.impl as typeof fetch);
  assert.equal(response.status, 200);
  assert.equal(fake.calls(), 1);
});
