import type { Connector, ConnectorDataset, FetchImpl } from '../connectors.js';

// World Bank answers REST v2 as [metadata, rows]; each row names an indicator.
const baseUrl = 'https://api.worldbank.org/v2';
// One series is enough to carry the comparison context S11 asks for.
const indicator = 'SP.POP.TOTL';
const seriesUrl = `${baseUrl}/country/PHL/indicator/${indicator}?format=json&per_page=1000`;

const fail = (status: number | undefined, detail: string) =>
  new Error(`worldbank: ${status === undefined ? 'no HTTP status' : `HTTP ${status}`}: ${detail}`);

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

export const worldBank: Connector = {
  id: 'worldbank',
  name: 'World Bank (Philippines)',
  protocol: 'json-rest',
  kind: 'api',
  baseUrl,
  externalBenchmark: true,
  async listDatasets(fetchImpl: FetchImpl) {
    const response = await fetchImpl(seriesUrl);
    if (!response.ok) throw fail(response.status, `reading ${seriesUrl} failed`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw fail(response.status, 'the body is not JSON'); }
    if (!Array.isArray(payload) || !Array.isArray(payload[1])) throw fail(response.status, 'the payload is not [metadata, rows]');
    const datasets = new Map<string, ConnectorDataset>();
    for (const [index, row] of (payload[1] as unknown[]).entries()) {
      if (!row || typeof row !== 'object') throw fail(response.status, `row ${index} is not an object`);
      const record = row as Record<string, unknown>;
      const indicatorRecord = record.indicator && typeof record.indicator === 'object' ? record.indicator as Record<string, unknown> : {};
      const countryRecord = record.country && typeof record.country === 'object' ? record.country as Record<string, unknown> : {};
      const id = text(indicatorRecord.id);
      const name = text(indicatorRecord.value);
      if (!id || !name) throw fail(response.status, `row ${index} has no indicator id or value`);
      if (datasets.has(id)) continue;
      datasets.set(id, {
        id,
        name,
        description: `World Bank indicator ${id} for ${text(countryRecord.value) ?? 'the Philippines'}; external benchmark, not Philippine government data`,
        attribution: 'World Bank open data',
      });
    }
    return { datasets: [...datasets.values()], httpStatus: response.status };
  },
};
