import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../src/gate.ts';

test('admits work up to the limit and then refuses', () => {
  const gate = createGate(2);
  const first = gate.tryAcquire();
  const second = gate.tryAcquire();
  assert.ok(first && second);
  assert.equal(gate.tryAcquire(), undefined);
});

test('releasing a slot admits the next job', () => {
  const gate = createGate(1);
  const release = gate.tryAcquire();
  assert.ok(release);
  assert.equal(gate.tryAcquire(), undefined);
  release!();
  assert.ok(gate.tryAcquire());
});

test('a double release does not free an extra slot', () => {
  const gate = createGate(1);
  const release = gate.tryAcquire()!;
  release();
  release();
  const next = gate.tryAcquire();
  assert.ok(next);
  assert.equal(gate.tryAcquire(), undefined);
});

test('edge cases: double release, reuse, and bounded acquisitions', () => {
  const one = createGate(1);
  const token = one.tryAcquire()!;
  token();
  token();
  assert.ok(one.tryAcquire());
  assert.equal(one.tryAcquire(), undefined);
  assert.equal(createGate(0).tryAcquire(), undefined);

  const gate = createGate(2);
  let held = 0;
  let max = 0;
  const tokens: Array<() => void> = [];
  for (let index = 0; index < 200; index += 1) {
    const release = gate.tryAcquire();
    if (release) {
      held += 1;
      max = Math.max(max, held);
      tokens.push(release);
    } else {
      assert.equal(held, 2);
    }
  }
  assert.equal(tokens.length, 2);
  assert.equal(max, 2);
  tokens[0]();
  assert.ok(gate.tryAcquire());
  assert.equal(gate.tryAcquire(), undefined);
});
