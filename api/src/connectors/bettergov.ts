import { selectDataResource, type Connector, type ConnectorDataset, type FetchImpl } from '../connectors.js';
import { detectFormat, type Format } from '../uploadPolicy.js';

// BetterGov answers a documented OpenAPI shape: { success, data: [...] }.
const baseUrl = 'https://data.bettergov.ph';
const datasetsUrl = `${baseUrl}/api/v1/datasets`;

const fail = (status: number | undefined, detail: string) =>
  new Error(`bettergov: ${status === undefined ? 'no HTTP status' : `HTTP ${status}`}: ${detail}`);

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const attributionText = (value: unknown): string | undefined => {
  if (!Array.isArray(value) || !value.length) return undefined;
  const first = value[0];
  if (!first || typeof first !== 'object') return undefined;
  const record = first as Record<string, unknown>;
  return text(record.attribution_text) ?? text(record.authors);
};

const resourceFormat = (format: unknown, filename: string): Format | undefined =>
  detectFormat(filename) ?? (typeof format === 'string' ? detectFormat(`resource.${format}`) : undefined);

const resourceUrl = (value: Record<string, unknown>) => text(value.download_url) ?? text(value.url);

export const betterGov: Connector = {
  id: 'bettergov',
  name: 'BetterGovPH',
  protocol: 'json-rest',
  kind: 'api',
  baseUrl: 'https://data.bettergov.ph',
  async listDatasets(fetchImpl: FetchImpl) {
    const response = await fetchImpl(datasetsUrl);
    if (!response.ok) throw fail(response.status, `reading ${datasetsUrl} failed`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw fail(response.status, 'the body is not JSON'); }
    const data = record(payload) ? payload.data : undefined;
    if (!Array.isArray(data)) throw fail(response.status, 'the payload has no data array');
    const datasets: ConnectorDataset[] = data.map((item, index) => {
      if (!item || typeof item !== 'object') throw fail(response.status, `dataset ${index} is not an object`);
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'number' ? String(record.id) : text(record.id);
      const name = text(record.name);
      if (!id || !name) throw fail(response.status, `dataset ${index} has no id or name`);
      const updatedAt = text(record.latest_version_date);
      const attribution = attributionText(record.attribution);
      return {
        id,
        name,
        description: text(record.description) ?? '',
        ...(updatedAt ? { updatedAt } : {}),
        ...(attribution ? { attribution } : {}),
      };
    });
    return { datasets, httpStatus: response.status };
  },
  async fetchDataset(datasetId: string, fetchImpl: FetchImpl) {
    const detailUrl = `${baseUrl}/api/v1/datasets/${encodeURIComponent(datasetId)}`;
    const detailResponse = await fetchImpl(detailUrl);
    if (!detailResponse.ok) throw fail(detailResponse.status, `reading ${detailUrl} failed`);
    let detail: unknown;
    try { detail = await detailResponse.json(); } catch { throw fail(detailResponse.status, 'the detail body is not JSON'); }
    const data = record(detail) ? detail.data : undefined;
    const item = Array.isArray(data)
      ? data.find((entry) => record(entry) && String(entry.id ?? '') === datasetId) ?? data[0]
      : data;
    if (!record(item)) throw fail(detailResponse.status, 'the dataset detail is missing');
    const dataset = item as Record<string, unknown>;

    const resourcesUrl = `${baseUrl}/api/v1/resources?dataset_id=${encodeURIComponent(text(dataset.id) ?? datasetId)}`;
    const resourcesResponse = await fetchImpl(resourcesUrl);
    if (!resourcesResponse.ok) throw fail(resourcesResponse.status, `reading ${resourcesUrl} failed`);
    let resourcesPayload: unknown;
    try { resourcesPayload = await resourcesResponse.json(); } catch { throw fail(resourcesResponse.status, 'the resource body is not JSON'); }
    const resources = record(resourcesPayload) ? resourcesPayload.data : undefined;
    if (!Array.isArray(resources)) throw fail(resourcesResponse.status, 'the resource payload has no data array');
    const candidates = resources.flatMap((entry) => {
      if (!record(entry)) return [];
      const url = resourceUrl(entry);
      const filename = text(entry.name) ?? url?.split('/').pop() ?? '';
      if (!url) return [];
      const format = resourceFormat(entry.format, filename);
      return format ? [{ entry, url, name: filename, bytes: Number(entry.size_bytes ?? 0), format }] : [];
    });
    const resource = selectDataResource(candidates)?.entry;
    if (!record(resource)) throw fail(resourcesResponse.status, `dataset ${datasetId} has no downloadable resource`);
    const url = resourceUrl(resource);
    if (!url) throw fail(resourcesResponse.status, `dataset ${datasetId} has no downloadable resource`);
    const filename = text(resource.name) ?? url.split('/').pop() ?? `${datasetId}.csv`;
    const format = resourceFormat(resource.format, filename);
    if (!format) throw fail(resourcesResponse.status, `resource ${filename} has no supported format`);

    const bytesResponse = await fetchImpl(url);
    if (!bytesResponse.ok) throw fail(bytesResponse.status, `reading ${url} failed`);
    const bytes = new Uint8Array(await bytesResponse.arrayBuffer());
    const licence = text(dataset.licence) ?? text(dataset.license);
    const attribution = attributionText(dataset.attribution) ?? 'BetterGovPH';
    return { bytes, filename, format, ...(licence ? { licence } : {}), attribution,
      name: text(dataset.name) ?? datasetId, description: text(dataset.description) ?? '' };
  },
};
