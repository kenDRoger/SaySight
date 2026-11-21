import type { Connector, ConnectorDataset, FetchImpl } from '../connectors.js';

// PSA OpenSTAT is a PxWeb server; the API root lists the top-level databases.
const baseUrl = 'https://openstat.psa.gov.ph/PXWeb/api/v1/en';
const rootUrl = baseUrl;

const fail = (status: number | undefined, detail: string) =>
  new Error(`openstat: ${status === undefined ? 'no HTTP status' : `HTTP ${status}`}: ${detail}`);

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

export const openStat: Connector = {
  id: 'openstat',
  name: 'PSA OpenSTAT',
  protocol: 'pxweb',
  kind: 'api',
  baseUrl,
  async listDatasets(fetchImpl: FetchImpl) {
    const response = await fetchImpl(rootUrl);
    if (!response.ok) throw fail(response.status, `reading ${rootUrl} failed`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw fail(response.status, 'the body is not JSON'); }
    if (!Array.isArray(payload)) throw fail(response.status, 'the payload is not a list of databases');
    const datasets: ConnectorDataset[] = payload.map((item, index) => {
      if (!item || typeof item !== 'object') throw fail(response.status, `database ${index} is not an object`);
      const record = item as Record<string, unknown>;
      const id = text(record.dbid);
      const name = text(record.text);
      if (!id || !name) throw fail(response.status, `database ${index} has no dbid or text`);
      // The table levels under /{dbid} are fetched on demand, not listed here.
      return { id, name, description: `PSA OpenSTAT table database ${id}` };
    });
    return { datasets, httpStatus: response.status };
  },
  async fetchDataset() {
    // /{dbid} lists tables, not observations; picking one needs a real query API.
    throw new Error('openstat cannot be pinned yet: PxWeb table selection is not implemented');
  },
};
