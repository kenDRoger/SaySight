import type { Connector, ConnectorDataset, FetchImpl } from '../connectors.js';

// BetterGov answers a documented OpenAPI shape: { success, data: [...] }.
const datasetsUrl = 'https://data.bettergov.ph/api/v1/datasets';

const fail = (status: number | undefined, detail: string) =>
  new Error(`bettergov: ${status === undefined ? 'no HTTP status' : `HTTP ${status}`}: ${detail}`);

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

const attributionText = (value: unknown): string | undefined => {
  if (!Array.isArray(value) || !value.length) return undefined;
  const first = value[0];
  if (!first || typeof first !== 'object') return undefined;
  const record = first as Record<string, unknown>;
  return text(record.attribution_text) ?? text(record.authors);
};

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
    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).data
      : undefined;
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
};
