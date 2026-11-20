import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplainer, explanationLimit, templateExplanation, templateVersion } from '../src/explain.ts';

const evidence = {
  recipe: 'summary', recipeVersion: '1',
  filters: { year: 2024 },
  inputRows: 27, outputRows: 1,
  validation: { status: 'Pass', checks: [] },
  warnings: ['partial coverage'], limitations: ['GAA only'],
  result: { total: 1 },
};

const provider = { name: 'test', model: 'm1', endpoint: 'http://model.test/v1/chat' };
const okResponse = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

test('the template is deterministic, bounded, and adds no figures', () => {
  const first = templateExplanation(evidence);
  assert.equal(first, templateExplanation(evidence));
  assert.ok(first.length <= explanationLimit);
  assert.match(first, /27 input rows/);
  assert.match(first, /year=2024/);
  assert.match(first, /Validation reported Pass/);
  assert.match(first, /partial coverage/);
  assert.match(first, /adds no new figures/);
});

test('with no provider configured the template answers', async () => {
  const explainer = createExplainer({});
  const explanation = await explainer.explain(evidence);
  assert.equal(explanation.source, 'template');
  assert.equal(explanation.templateVersion, templateVersion);
});

test('a provider answer is used and recorded', async () => {
  const explainer = createExplainer({ provider, request: (async () => okResponse('Coverage for 2024 is summarised in one row.')) as typeof fetch });
  const explanation = await explainer.explain(evidence);
  assert.equal(explanation.source, 'llm');
  assert.equal(explanation.provider, 'test');
  assert.equal(explanation.model, 'm1');
  assert.equal(explanation.text, 'Coverage for 2024 is summarised in one row.');
});

test('a failing provider falls back instead of failing the request', async () => {
  for (const request of [
    (async () => new Response('nope', { status: 500 })) as typeof fetch,
    (async () => { throw new Error('network'); }) as unknown as typeof fetch,
    (async () => new Response('{not json', { status: 200 })) as typeof fetch,
    (async () => okResponse('')) as typeof fetch,
    (async () => okResponse('x'.repeat(explanationLimit + 1))) as typeof fetch,
  ]) {
    const explanation = await createExplainer({ provider, request }).explain(evidence);
    assert.equal(explanation.source, 'template');
  }
});

test('the provider sees only the bounded structured result', async () => {
  let body = '';
  const request = (async (_url: string, init: { body?: string }) => { body = init.body ?? ''; return okResponse('fine'); }) as unknown as typeof fetch;
  await createExplainer({ provider, request }).explain(evidence);
  const prompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0].content;
  assert.match(prompt, /Do not calculate/);
  assert.match(prompt, /"input_rows":27/);
  assert.ok(prompt.length < 20000);
});
