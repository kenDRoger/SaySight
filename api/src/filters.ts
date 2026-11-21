// Search and filter rules for the catalog and the review queue. They are pure so
// the routes stay thin, and so the vocabulary is tested without a database.
import { isImpact, type Impact } from './impact.js';
import { isStatus, type Status } from './review.js';

// The one failure shape the routes turn into `400 { error: "invalid_filter",
// parameter }`; the parameter name tells the caller which value to correct.
export type InvalidFilter = { error: 'invalid_filter'; parameter: string };

const invalid = (parameter: string): InvalidFilter => ({ error: 'invalid_filter', parameter });

export const isInvalidFilter = (value: unknown): value is InvalidFilter =>
  typeof value === 'object' && value !== null && (value as { error?: unknown }).error === 'invalid_filter';

// An absent or empty query parameter is "no filter", never an invalid value.
const blank = (value: unknown): value is undefined | null | '' => value === undefined || value === null || value === '';

// The store defaults unverified releases to `unknown`, so the filter offers only
// the words a caller can ask for; anything else is refused rather than ignored.
export const freshnesses = ['current', 'possibly_stale', 'stale'] as const;
export type Freshness = (typeof freshnesses)[number];

export type CatalogEntry = {
  name: string;
  publisher: string;
  releaseId: string;
  agencyId?: string | null;
  freshnessStatus?: string | null;
};

export type QueueEntry = { status: string; impact: string; claim?: string | null };

export const matchCatalogQuery = (dataset: CatalogEntry, query: string) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [dataset.name, dataset.publisher, dataset.releaseId, dataset.agencyId ?? '']
    .some((field) => field.toLowerCase().includes(needle));
};

export function parseFreshness(value: unknown): Freshness | undefined | InvalidFilter {
  if (blank(value)) return undefined;
  return (freshnesses as readonly unknown[]).includes(value) ? (value as Freshness) : invalid('freshness');
}

export function filterDatasets<T extends CatalogEntry>(
  datasets: T[],
  filters: { q?: string | null; agency?: string | null; freshness?: unknown },
): T[] | InvalidFilter {
  const freshness = parseFreshness(filters.freshness);
  if (isInvalidFilter(freshness)) return freshness;
  const agency = blank(filters.agency) ? undefined : filters.agency;
  return datasets.filter((dataset) =>
    matchCatalogQuery(dataset, filters.q ?? '')
    && (agency === undefined || dataset.agencyId === agency)
    // A release with no freshness is `unknown`, which no filter value names.
    && (freshness === undefined || (dataset.freshnessStatus ?? 'unknown') === freshness));
}

export function filterQueue<T extends QueueEntry>(
  findings: T[],
  filters: { status?: unknown; impact?: unknown; q?: unknown },
): T[] | InvalidFilter {
  // A misspelled status or impact is reported, never read as "everything".
  if (!blank(filters.status) && !isStatus(filters.status)) return invalid('status');
  if (!blank(filters.impact) && !isImpact(filters.impact)) return invalid('impact');
  const status: Status | undefined = blank(filters.status) ? undefined : filters.status as Status;
  const impact: Impact | undefined = blank(filters.impact) ? undefined : filters.impact as Impact;
  const needle = typeof filters.q === 'string' ? filters.q.trim().toLowerCase() : '';
  return findings.filter((finding) =>
    (status === undefined || finding.status === status)
    && (impact === undefined || finding.impact === impact)
    && (!needle || (finding.claim ?? '').toLowerCase().includes(needle)));
}
