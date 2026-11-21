import { betterGov } from './connectors/bettergov.js';
import { hdx } from './connectors/hdx.js';
import { openStat } from './connectors/openstat.js';
import { worldBank } from './connectors/worldbank.js';

export type ConnectorDataset = {
  id: string;
  name: string;
  description: string;
  updatedAt?: string;
  licence?: string;
  attribution?: string;
};

export type ConnectorListing = { datasets: ConnectorDataset[]; httpStatus: number };

// Every connector takes its HTTP reader as an argument so tests never hit a portal.
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
};

// A link-out is never fetched: SaySight points the reader at the portal instead of
// faking a dataset list it cannot read (S8, S8a).
const linkOut = (id: string, name: string, baseUrl: string): Connector => ({
  id, name, protocol: 'link-out', kind: 'link-out', baseUrl,
  async listDatasets() { return { datasets: [], httpStatus: 200 }; },
});

export const connectors: Connector[] = [
  betterGov,
  hdx,
  worldBank,
  openStat,
  linkOut('data-gov-ph', 'data.gov.ph', 'https://data.gov.ph'),
  linkOut('psada', 'PSADA (PSA data archive)', 'https://psada.psa.gov.ph'),
  linkOut('opendata-org-ph', 'Open Data Philippines', 'https://opendata.org.ph'),
  linkOut('cids', 'UP CIDS', 'https://cids.up.edu.ph'),
];

export function getConnector(id: string): Connector | undefined {
  return connectors.find((connector) => connector.id === id);
}
