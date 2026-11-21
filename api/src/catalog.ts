export type DatasetStatus = 'current' | 'possibly_stale' | 'import_failed' | 'reuse_terms_unclear';

export interface DatasetRelease {
  id: string;
  name: string;
  publisher: string;
  sourceUrl: string;
  releaseId: string;
  checksum: string;
  coverage: { fiscalYears: number[] };
  fields: Array<{ name: string; type: string; unit?: string; description: string }>;
  reuseTerms: string;
  status: DatasetStatus;
  limitations: string[];
  agencyId?: string | null;
  region?: string | null;
  lastCheckedAt?: string | null;
  sourcePublishedAt?: string | null;
  sourceUpdatedAt?: string | null;
  freshnessStatus?: string;
  licenceStatus?: string;
  attribution?: string;
  connectorId?: string | null;
  schema?: unknown;
  rowCount?: number;
}

// MVP-A starts with a verified contract-shaped catalog record. The live BetterGov
// adapter is intentionally isolated until a release and reuse terms are confirmed.
export const catalog: DatasetRelease[] = [
  {
    id: 'bettergov-gaa-coverage-2026-11-07',
    name: 'Philippine General Appropriations Act coverage, FY2000–FY2026',
    publisher: 'BetterGovPH',
    sourceUrl: 'https://data.bettergov.ph/datasets/27',
    releaseId: 'bettergovph/gaa-2000-2026@2026-11-07',
    checksum: 'adeb99733363fce2eba380a21228e69a6cfbc27a40bb685c3c7700f136532d5b',
    coverage: { fiscalYears: Array.from({ length: 27 }, (_, index) => 2000 + index) },
    fields: [
      { name: 'year', type: 'integer', description: 'Fiscal year' },
      { name: 'status', type: 'string', description: 'Coverage status for the year' },
      { name: 'rows', type: 'integer', description: 'Number of source rows' },
      { name: 'amount_pesos', type: 'number', unit: 'PHP', description: 'Recorded amount where available' },
      { name: 'scopes', type: 'object', unit: 'PHP', description: 'Amounts by documented scope' },
      { name: 'grains', type: 'object', description: 'Row counts by data grain' },
      { name: 'notes', type: 'array', description: 'Coverage and comparability limitations' },
      { name: 'path', type: 'string', description: 'Source parquet path' },
    ],
    reuseTerms: 'CC0 1.0 Universal',
    status: 'current',
    agencyId: 'bettergov',
    region: 'Philippines',
    // Derived from the verified release id; no unpublished source date is invented.
    lastCheckedAt: '2026-11-07T00:00:00.000Z',
    sourcePublishedAt: null,
    sourceUpdatedAt: null,
    freshnessStatus: 'current',
    limitations: [
      'Coverage varies by year; 2001, 2004, and 2006 have no rows because the prior year GAA was reenacted.',
      'The coverage table must be read before comparing years; amounts are appropriations, not obligations, releases, or spending.',
    ],
  },
];
