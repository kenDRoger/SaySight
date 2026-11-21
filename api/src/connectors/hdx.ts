import { selectDataResource, type Connector, type ConnectorDataset, type FetchImpl } from '../connectors.js';
import { detectFormat, type Format } from '../uploadPolicy.js';

// HDX is a CKAN portal; package_search answers { success, result: { count, results } }.
const baseUrl = 'https://data.humdata.org';
const searchUrl = `${baseUrl}/api/3/action/package_search?fq=groups:phl&rows=1000`;

const fail = (status: number | undefined, detail: string) =>
  new Error(`hdx: ${status === undefined ? 'no HTTP status' : `HTTP ${status}`}: ${detail}`);

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const resourceFormat = (format: unknown, filename: string): Format | undefined =>
  detectFormat(filename) ?? (typeof format === 'string' ? detectFormat(`resource.${format}`) : undefined);

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
    const result = record(payload) ? payload.result : undefined;
    const results = record(result) ? result.results : undefined;
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
  async fetchDataset(datasetId: string, fetchImpl: FetchImpl) {
    const packageUrl = `${baseUrl}/api/3/action/package_show?id=${encodeURIComponent(datasetId)}`;
    const response = await fetchImpl(packageUrl);
    if (!response.ok) throw fail(response.status, `reading ${packageUrl} failed`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw fail(response.status, 'the body is not JSON'); }
    const result = record(payload) ? payload.result : undefined;
    if (!record(result)) throw fail(response.status, 'the package_show payload has no result');
    const resources = result.resources;
    if (!Array.isArray(resources)) throw fail(response.status, 'the package has no resources');
    const candidates = resources.flatMap((entry) => {
      if (!record(entry)) return [];
      const url = text(entry.url);
      const filename = text(entry.name) ?? url?.split('/').pop() ?? '';
      const format = resourceFormat(entry.format, filename);
      if (!url || (format !== 'csv' && format !== 'json')) return [];
      return [{ entry, url, name: filename, bytes: Number(entry.size ?? 0), format }];
    });
    const resource = selectDataResource(candidates)?.entry;
    if (!record(resource)) throw fail(response.status, `package ${datasetId} has no csv or json resource`);
    const url = text(resource.url);
    if (!url) throw fail(response.status, `package ${datasetId} has no resource URL`);
    const filename = text(resource.name) ?? url.split('/').pop() ?? `${datasetId}.csv`;
    const format = resourceFormat(resource.format, filename);
    if (format !== 'csv' && format !== 'json') throw fail(response.status, `resource ${filename} is not csv or json`);

    const bytesResponse = await fetchImpl(url);
    if (!bytesResponse.ok) throw fail(bytesResponse.status, `reading ${url} failed`);
    const bytes = new Uint8Array(await bytesResponse.arrayBuffer());
    const organisation = record(result.organization) ? result.organization : undefined;
    const attribution = text(organisation?.title) ?? text(result.notes) ?? 'HDX';
    const licence = text(result.license_title);
    return { bytes, filename, format, ...(licence ? { licence } : {}), attribution,
      name: text(result.title) ?? datasetId, description: text(result.notes) ?? '' };
  },
};
