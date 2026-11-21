import type { Connector, ConnectorDataset, FetchImpl } from '../connectors.js';

// HDX is a CKAN portal; package_search answers { success, result: { count, results } }.
const baseUrl = 'https://data.humdata.org';
const searchUrl = `${baseUrl}/api/3/action/package_search?fq=groups:phl&rows=1000`;

const fail = (status: number | undefined, detail: string) =>
  new Error(`hdx: ${status === undefined ? 'no HTTP status' : `HTTP ${status}`}: ${detail}`);

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

export const hdx: Connector = {
  id: 'hdx',
  name: 'Humanitarian Data Exchange (Philippines)',
  protocol: 'ckan',
  kind: 'api',
  baseUrl,
  async listDatasets(fetchImpl: FetchImpl) {
    const response = await fetchImpl(searchUrl);
    if (!response.ok) throw fail(response.status, `reading ${searchUrl} failed`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw fail(response.status, 'the body is not JSON'); }
    const result = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).result
      : undefined;
    const results = result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).results
      : undefined;
    if (!Array.isArray(results)) throw fail(response.status, 'the payload has no result.results array');
    const datasets: ConnectorDataset[] = results.map((item, index) => {
      if (!item || typeof item !== 'object') throw fail(response.status, `dataset ${index} is not an object`);
      const record = item as Record<string, unknown>;
      const id = text(record.name);
      const name = text(record.title);
      if (!id || !name) throw fail(response.status, `dataset ${index} has no name or title`);
      const updatedAt = text(record.metadata_modified);
      const licence = text(record.license_title);
      const attribution = text(record.organization && typeof record.organization === 'object'
        ? (record.organization as Record<string, unknown>).title : undefined);
      return {
        id,
        name,
        description: text(record.notes) ?? '',
        ...(updatedAt ? { updatedAt } : {}),
        ...(licence ? { licence } : {}),
        ...(attribution ? { attribution } : {}),
      };
    });
    return { datasets, httpStatus: response.status };
  },
};
