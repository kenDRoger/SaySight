import assert from 'node:assert/strict';
import test from 'node:test';

const { connectors, getConnector, selectDataResource } = await import('tsx/esm/api').then(async ({ tsImport }) =>
  tsImport<typeof import('../src/connectors.ts')>('../src/connectors.ts', import.meta.url));

// A fetch stand-in: tests never reach a portal.
const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
const networkForbidden = (async () => { throw new Error('a test tried to reach the network'); }) as unknown as typeof fetch;

const first = (dataset: unknown, expected: Record<string, unknown>) => {
  const record = dataset as Record<string, unknown>;
  return Object.fromEntries(Object.keys(expected).map((key) => [key, record[key]]));
};

type Case = { id: string; payload: unknown; expected: Record<string, unknown>; wrongShape: unknown };

// Each fixture is the documented shape of its portal, reduced to one dataset.
const cases: Case[] = [
  {
    id: 'bettergov',
    payload: {
      success: true,
      data: [{
        id: 'gaa-coverage', name: 'GAA coverage', description: 'Budget coverage by year',
        publisher_id: 3, category_id: 2, tags: ['budget'], size_bytes: 1024, latest_version_date: '2026-01-05',
        attribution: [{ authors: 'DBM', source_url: 'https://data.bettergov.ph', attribution_text: 'DBM open data' }],
      }],
    },
    expected: { id: 'gaa-coverage', name: 'GAA coverage', description: 'Budget coverage by year', updatedAt: '2026-01-05', attribution: 'DBM open data' },
    wrongShape: { success: true, data: {} },
  },
  {
    id: 'hdx',
    payload: {
      success: true,
      result: {
        count: 1,
        results: [{
          name: 'phl-food-prices', title: 'Philippines food prices', notes: 'Monthly prices',
          resources: [{ name: 'prices.csv', format: 'CSV', url: 'https://data.humdata.org/x.csv' }],
        }],
      },
    },
    expected: { id: 'phl-food-prices', name: 'Philippines food prices', description: 'Monthly prices' },
    wrongShape: { success: true, result: { count: 0 } },
  },
  {
    id: 'worldbank',
    payload: [
      { page: 1, pages: 1, per_page: 1000, total: 1 },
      [{ indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { id: 'PHL', value: 'Philippines' }, date: '2023', value: 117337368 }],
    ],
    expected: { id: 'SP.POP.TOTL', name: 'Population, total' },
    wrongShape: { message: [{ id: '120', value: 'Invalid value' }] },
  },
  {
    id: 'openstat',
    payload: [{ dbid: 'DB1', text: 'Population and Housing' }],
    expected: { id: 'DB1', name: 'Population and Housing' },
    wrongShape: { error: 'unavailable' },
  },
];

for (const { id, payload, expected, wrongShape } of cases) {
  const connector = getConnector(id);
  assert.ok(connector, `${id} is registered`);

  test(`${id} parses its documented shape`, async () => {
    const listing = await connector.listDatasets(respond(payload));
    assert.equal(listing.httpStatus, 200);
    assert.equal(listing.datasets.length, 1);
    assert.deepEqual(first(listing.datasets[0], expected), expected);
  });

  test(`${id} maps a 500 to an error naming the connector and the HTTP status`, async () => {
    await assert.rejects(connector.listDatasets(respond({ error: 'down' }, 500)), (error: Error) => {
      assert.match(error.message, new RegExp(`^${id}: HTTP 500`));
      return true;
    });
  });

  test(`${id} maps a non-JSON body to an error naming the connector and the HTTP status`, async () => {
    await assert.rejects(connector.listDatasets(respond('<html>not json</html>')), (error: Error) => {
      assert.match(error.message, new RegExp(`^${id}: HTTP 200: `));
      assert.match(error.message, /not JSON/);
      return true;
    });
  });

  test(`${id} maps an unexpected payload shape to an error naming the connector`, async () => {
    await assert.rejects(connector.listDatasets(respond(wrongShape)), (error: Error) => {
      assert.match(error.message, new RegExp(`^${id}: HTTP 200: `));
      assert.match(error.message, /payload/);
      return true;
    });
  });
}

test('World Bank is marked as an external benchmark', () => {
  assert.equal(getConnector('worldbank')?.externalBenchmark, true);
  for (const id of ['bettergov', 'hdx', 'openstat']) assert.equal(getConnector(id)?.externalBenchmark, undefined);
});

test('the link-out sources return an empty list and are never fetched', async () => {
  const linkOuts = connectors.filter((connector) => connector.kind === 'link-out');
  assert.deepEqual(linkOuts.map((connector) => connector.id), ['data-gov-ph', 'psada', 'opendata-org-ph', 'cids']);
  for (const connector of linkOuts) assert.deepEqual((await connector.listDatasets(networkForbidden)).datasets, []);
});

test('the registry holds the four API connectors plus the link-out entries', () => {
  assert.equal(connectors.length, 8);
  assert.deepEqual(connectors.filter((connector) => connector.kind === 'api').map((connector) => connector.id), ['bettergov', 'hdx', 'worldbank', 'openstat']);
  assert.deepEqual(connectors.map((connector) => connector.protocol).slice(0, 4), ['json-rest', 'ckan', 'json-rest', 'pxweb']);
  assert.equal(getConnector('nope'), undefined);
});

// fetchDataset fixtures: every portal byte comes from an injected reader.
const fetchFrom = (responses: Map<string, string>, calls: string[]): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = responses.get(url);
    if (body === undefined) throw new Error(`unfixtured URL ${url}`);
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;

test('bettergov fetches the detail, the first downloadable resource, then its bytes', async () => {
  const responses = new Map([
    ['https://data.bettergov.ph/api/v1/datasets/gaa-coverage', JSON.stringify({
      success: true,
      data: { id: 'gaa-coverage', name: 'GAA coverage', description: 'Budget coverage by year', licence: 'CC BY 4.0',
        attribution: [{ attribution_text: 'DBM open data' }] },
    })],
    ['https://data.bettergov.ph/api/v1/resources?dataset_id=gaa-coverage', JSON.stringify({
      success: true,
      data: [
        { name: 'notes.pdf', format: 'PDF', url: 'https://data.bettergov.ph/files/notes.pdf' },
        { name: 'gaa.csv', format: 'CSV', url: 'https://data.bettergov.ph/files/gaa.csv' },
      ],
    })],
    ['https://data.bettergov.ph/files/gaa.csv', 'year,value\n2024,1\n'],
  ]);
  const calls: string[] = [];
  const pinned = await getConnector('bettergov')!.fetchDataset('gaa-coverage', fetchFrom(responses, calls));
  assert.deepEqual(calls, [...responses.keys()]);
  assert.equal(Buffer.from(pinned.bytes).toString('utf8'), 'year,value\n2024,1\n');
  assert.deepEqual({ filename: pinned.filename, format: pinned.format, licence: pinned.licence, attribution: pinned.attribution, name: pinned.name, description: pinned.description },
    { filename: 'gaa.csv', format: 'csv', licence: 'CC BY 4.0', attribution: 'DBM open data', name: 'GAA coverage', description: 'Budget coverage by year' });
});

test('hdx fetches package_show, the first csv/json resource, then its bytes', async () => {
  const responses = new Map([
    ['https://data.humdata.org/api/3/action/package_show?id=phl-food-prices', JSON.stringify({
      success: true,
      result: { name: 'phl-food-prices', title: 'Philippines food prices', notes: 'Monthly prices', license_title: 'ODC-By',
        organization: { title: 'WFP Philippines' },
        resources: [
          { name: 'prices.xlsx', format: 'XLSX', url: 'https://data.humdata.org/x.xlsx' },
          { name: 'prices.csv', format: 'CSV', url: 'https://data.humdata.org/x.csv' },
        ] },
    })],
    ['https://data.humdata.org/x.csv', 'date,price\n2024-01-01,10\n'],
  ]);
  const calls: string[] = [];
  const pinned = await getConnector('hdx')!.fetchDataset('phl-food-prices', fetchFrom(responses, calls));
  assert.deepEqual(calls, [...responses.keys()]);
  assert.equal(Buffer.from(pinned.bytes).toString('utf8'), 'date,price\n2024-01-01,10\n');
  assert.deepEqual({ filename: pinned.filename, format: pinned.format, licence: pinned.licence, attribution: pinned.attribution, name: pinned.name, description: pinned.description },
    { filename: 'prices.csv', format: 'csv', licence: 'ODC-By', attribution: 'WFP Philippines', name: 'Philippines food prices', description: 'Monthly prices' });
});

test('worldbank serialises the indicator rows as JSON bytes', async () => {
  const rows = [{ indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { value: 'Philippines' }, date: '2023', value: 117337368 }];
  const responses = new Map([
    ['https://api.worldbank.org/v2/country/PHL/indicator/SP.POP.TOTL?format=json&per_page=1000',
      JSON.stringify([{ page: 1, pages: 1, per_page: 1000, total: 1 }, rows])],
  ]);
  const calls: string[] = [];
  const pinned = await getConnector('worldbank')!.fetchDataset('SP.POP.TOTL', fetchFrom(responses, calls));
  assert.deepEqual(calls, [...responses.keys()]);
  assert.deepEqual(JSON.parse(Buffer.from(pinned.bytes).toString('utf8')), rows);
  assert.deepEqual({ filename: pinned.filename, format: pinned.format, attribution: pinned.attribution, name: pinned.name },
    { filename: 'SP.POP.TOTL.json', format: 'json', attribution: 'World Bank open data', name: 'Population, total' });
  assert.match(pinned.description, /external benchmark/);
});

test('openstat refuses pinning instead of pretending a table list is data', async () => {
  await assert.rejects(getConnector('openstat')!.fetchDataset('DB1', networkForbidden),
    { message: 'openstat cannot be pinned yet: PxWeb table selection is not implemented' });
});

test('link-outs refuse pinning with a named error', async () => {
  for (const connector of connectors.filter((item) => item.kind === 'link-out')) {
    await assert.rejects(connector.fetchDataset('anything', networkForbidden),
      { message: `${connector.id} is a link-out and has no data to pin` });
  }
});

test('resource selection skips provenance files and prefers the real data file', () => {
  const chosen = selectDataResource([
    { name: 'sources.json', url: 'https://example.org/sources.json', bytes: 2151, format: 'json' },
    { name: 'facilities.json', url: 'https://example.org/facilities.json', bytes: 9457158, format: 'json' },
    { name: 'README.md', url: 'https://example.org/README.md', bytes: 4000 },
  ]);
  assert.equal(chosen?.name, 'facilities.json');

  // With only provenance files available, the largest is still chosen rather than nothing.
  const onlyMetadata = selectDataResource([
    { name: 'sources.json', url: 'https://example.org/sources.json', bytes: 2151, format: 'json' },
  ]);
  assert.equal(onlyMetadata?.name, 'sources.json');

  assert.equal(selectDataResource([]), undefined);
});
