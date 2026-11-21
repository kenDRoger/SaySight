import type { Connector, ConnectorDataset, FetchImpl } from '../connectors.js';

// World Bank answers REST v2 as [metadata, rows]; each row names an indicator.
const baseUrl = 'https://api.worldbank.org/v2';
// One series is enough to carry the comparison context S11 asks for.
const indicator = 'SP.POP.TOTL';
const seriesUrl = `${baseUrl}/country/PHL/indicator/${indicator}?format=json&per_page=1000`;

const fail = (status: number | undefined, detail: string) =>
  new Error(`worldbank: ${status === undefined ? 'no HTTP status' : `HTTP ${status}`}: ${detail}`);

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

const indicatorUrl = (id: string) => `${baseUrl}/country/PHL/indicator/${encodeURIComponent(id)}?format=json&per_page=1000`;

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
  async fetchDataset(datasetId: string, fetchImpl: FetchImpl) {
    const url = indicatorUrl(datasetId);
    const response = await fetchImpl(url);
    if (!response.ok) throw fail(response.status, `reading ${url} failed`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw fail(response.status, 'the body is not JSON'); }
    if (!Array.isArray(payload) || !Array.isArray(payload[1])) throw fail(response.status, 'the payload is not [metadata, rows]');
    const rows = payload[1] as unknown[];
    const first = rows[0];
    const indicator = first && typeof first === 'object' && 'indicator' in first && typeof first.indicator === 'object' && first.indicator !== null
      ? first.indicator as Record<string, unknown> : undefined;
    const country = first && typeof first === 'object' && 'country' in first && typeof first.country === 'object' && first.country !== null
      ? first.country as Record<string, unknown> : undefined;
    const name = text(indicator?.value) ?? datasetId;
    const description = `World Bank indicator ${datasetId} for ${text(country?.value) ?? 'the Philippines'}; external benchmark, not Philippine government data`;
    // The exact API rows are the snapshot: no reshaping that could drift later.
    const bytes = new TextEncoder().encode(JSON.stringify(rows));
    return { bytes, filename: `${datasetId}.json`, format: 'json', attribution: 'World Bank open data', name, description };
  },
};
