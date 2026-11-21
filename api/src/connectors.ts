import { betterGov } from './connectors/bettergov.js';
import { hdx } from './connectors/hdx.js';
import { openStat } from './connectors/openstat.js';
import { worldBank } from './connectors/worldbank.js';
import type { Format } from './uploadPolicy.js';

export type ConnectorDataset = {
  id: string;
  name: string;
  description: string;
  updatedAt?: string;
  licence?: string;
  attribution?: string;
};

export type ConnectorListing = { datasets: ConnectorDataset[]; httpStatus: number };

// The exact bytes a connector fetched, with the disclosure S10a needs.
export type PinnedDataset = {
  bytes: Uint8Array;
  filename: string;
  format: Format;
  licence?: string;
  attribution: string;
  name: string;
  description: string;
};

// Every connector takes its HTTP reader as an argument so tests never hit a portal.
import { probeScraped } from './connectors/scrape.js';

export type FetchImpl = typeof fetch;

// 'link-out' is added to the API protocols because a link-out entry has no
// protocol of its own and claiming one would misstate the source.
export type ConnectorProtocol = 'json-rest' | 'ckan' | 'pxweb' | 'link-out';

export type Connector = {
  id: string;
  name: string;
  protocol: ConnectorProtocol;
  kind: 'api' | 'scraped' | 'link-out';
  baseUrl: string;
  externalBenchmark?: boolean;
  listDatasets(fetchImpl: FetchImpl): Promise<ConnectorListing>;
  fetchDataset(datasetId: string, fetchImpl: FetchImpl): Promise<PinnedDataset>;
};

// A scraped source is probed, not mirrored: it reports the links it actually
// exposes, or the reason it exposes none, and it can never be pinned as a whole
// because a page is not a dataset (S8).
const scraped = (id: string, name: string, baseUrl: string): Connector => ({
  id, name, protocol: 'link-out', kind: 'scraped', baseUrl,
  async listDatasets(fetchImpl: FetchImpl) {
    const probe = await probeScraped(baseUrl, fetchImpl);
    if (probe.status !== 'ok') throw new Error(`${id}: ${probe.message}`);
    return { datasets: probe.datasets, httpStatus: probe.httpStatus ?? 200 };
  },
  async fetchDataset(_datasetId: string) {
    throw new Error(`${id} is scraped: choose one of its listed datasets and upload the file, or pin a portal with an API`);
  },
});


// A portal often lists provenance files next to the data (sources.json, checksums,
// README). Picking the first supported resource pinned a 2 KB provenance file for a
// 9 MB dataset, so names that describe metadata are skipped and the largest
// remaining candidate wins.
const metadataName = /(^|[\/_.-])(sources?|checksums?|manifest|readme|metadata|license|licence|changelog|notes)([._-]|$)/i;

export type ResourceCandidate = { name: string; url: string; bytes: number; format?: string };

export function selectDataResource<T extends ResourceCandidate>(candidates: T[]): T | undefined {
  const supported = candidates.filter((candidate) => candidate.url && (!candidate.format || ['csv', 'json', 'xlsx', 'parquet'].includes(candidate.format)));
  const dataOnly = supported.filter((candidate) => !metadataName.test(candidate.name.split('/').pop() ?? candidate.name));
  const pool = dataOnly.length ? dataOnly : supported;
  return pool.reduce<T | undefined>((best, candidate) => (!best || candidate.bytes > best.bytes ? candidate : best), undefined);
}

export const connectors: Connector[] = [
  betterGov,
  hdx,
  worldBank,
  openStat,
  scraped('data-gov-ph', 'data.gov.ph', 'https://data.gov.ph'),
  scraped('psada', 'PSADA (PSA data archive)', 'https://psada.psa.gov.ph'),
  scraped('opendata-org-ph', 'Open Data Philippines', 'https://opendata.org.ph'),
  scraped('cids', 'UP CIDS', 'https://cids.up.edu.ph'),
];

export function getConnector(id: string): Connector | undefined {
  return connectors.find((connector) => connector.id === id);
}
