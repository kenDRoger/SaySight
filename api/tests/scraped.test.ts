import test from 'node:test';
import assert from 'node:assert/strict';
import { datasetLinks, datasetsFromHtml, extractLinks, looksLikeSpaShell, probeScraped } from '../src/connectors/scrape.ts';

const spa = '<!doctype html><html><head><meta charset="utf-8"></head><body><app-root></app-root><script src="main.js"></script></body></html>';
const rich = `<html><body>${Array.from({ length: 12 }, (_, index) => `<a href="/dataset/${index}">Dataset ${index}</a>`).join('')}</body></html>`;
const forbidden = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
const unreachable = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
const html = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;

test('an app shell is detected so a 200 is never read as a dataset list', () => {
  assert.equal(looksLikeSpaShell(spa), true);
  assert.equal(looksLikeSpaShell(rich), false);
});

test('links are absolute, de-duplicated, and drop anchors and mail links', () => {
  const page = '<a href="#top">top</a><a href="mailto:a@b.c">mail</a><a href="/datasets/27">GAA</a><a href="/datasets/27">again</a><a href="https://cdn.example.org/f.csv">csv</a>';
  assert.deepEqual(extractLinks(page, 'https://data.example.org'),
    ['https://data.example.org/datasets/27', 'https://cdn.example.org/f.csv']);
});

test('dataset links match paths, downloads, and data extensions only', () => {
  const page = '<a href="/about">About</a><a href="/datasets/27">GAA coverage</a><a href="/files/x.csv">CSV file</a><a href="/news">News</a>';
  const links = datasetLinks(page, 'https://example.org');
  assert.deepEqual(links.map((link) => link.url), ['https://example.org/datasets/27', 'https://example.org/files/x.csv']);
});

test('a scraped page yields named links, capped, and never inventing entries', () => {
  const result = datasetsFromHtml(rich, 'https://example.org');
  assert.equal(result.status, 'ok');
  assert.equal(result.datasets.length, 12);
  assert.equal(result.datasets[0]?.name, 'Dataset 0');
  assert.match(result.message, /exposes 12 dataset links/);

  const many = `<html><body>${Array.from({ length: 80 }, (_, i) => `<a href="/dataset/${i}">D${i}</a>`).join('')}</body></html>`;
  assert.equal(datasetsFromHtml(many, 'https://example.org').datasets.length, 50);

  const shell = datasetsFromHtml(spa, 'https://data.gov.ph');
  assert.equal(shell.status, 'spa-shell');
  assert.deepEqual(shell.datasets, []);
  assert.match(shell.message, /browser/);
});

test('probe reports forbidden and unreachable instead of an empty success', async () => {
  const denied = await probeScraped('https://psada.psa.gov.ph', forbidden);
  assert.equal(denied.status, 'forbidden');
  assert.equal(denied.httpStatus, 403);
  assert.deepEqual(denied.datasets, []);

  const dead = await probeScraped('https://example.org', unreachable);
  assert.equal(dead.status, 'unreachable');
  assert.equal(dead.httpStatus, null);
  assert.match(dead.message, /could not be reached/);

  const ok = await probeScraped('https://example.org', html(rich));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.datasets.length, 12);
});
