import { FormEvent, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@bettergov/kapwa/button';
import { Card } from '@bettergov/kapwa/card';
import { Input } from '@bettergov/kapwa/input';
import { Label } from '@bettergov/kapwa/label';
import { CompareChart, DistributionChart, RankChart, TrendChart, isCompareResult, isDistributionResult, isRankResult, isTrendResult } from './charts';
import './styles.css';

type Dataset = {
  id?: string;
  name: string;
  publisher: string;
  sourceUrl: string;
  releaseId: string;
  checksum: string;
  coverage: { fiscalYears: number[] };
  fields: Array<{ name: string; type: string; unit?: string; description: string }>;
  reuseTerms: string;
  limitations: string[];
  agencyId?: string | null;
  region?: string | null;
  freshnessStatus?: string;
  lastCheckedAt?: string | null;
  licenceStatus?: string;
  attribution?: string;
  metadata?: { schema?: { columns?: SchemaColumn[] } };
  rowCount?: number;
};

type SchemaColumn = { name: string; type?: string };
type ConnectorCheck = { status?: string; httpStatus?: number | null; datasetCount?: number | null; message?: string; createdAt?: string };
type Connector = { id: string; name: string; protocol: string; kind: 'api' | 'scraped'; baseUrl?: string; externalBenchmark: boolean; last_check?: ConnectorCheck | null; lastCheck?: ConnectorCheck | null };
type RunInsight = { id: string; recipe: string; status: 'ok' | 'skipped'; result?: unknown; calculation?: string; warnings?: string[]; reason?: string; evidence_id?: string | null };
type RunSelection = { applicable: string[]; skipped: Array<{ recipe: string; reason: string }> };
type RunResponse = { run_id: string; selection: RunSelection; insights: RunInsight[]; summary: string };

type Agency = { id: string; name: string; website: string };
type SavedView = { id: string; name: string; datasetReleaseId: string; filters: Record<string, unknown>; createdAt: string };
type ImportDraft = { id: string; name: string; filename: string; status: string; checkRows?: string; validation?: { rows?: number; status?: string; checks?: string[] } };

type Analysis = { recipe: string; calculation: string; input_rows: number; output_rows: number; result: unknown; validation: { status: string; checks: string[] }; warnings: string[]; limitations: string[]; reproducibility_status: string; evidence_id?: string };
type JoinedAnalysis = {
  matched_rows?: number; unmatched_left?: number; unmatched_right?: number; duplicate_right_keys?: number;
  input_left_rows?: number; input_right_rows?: number;
  evidence_id?: string; analysis_run_id?: string; relationship_id?: string; reproducibility_status?: string;
  validation?: { status?: string; checks?: string[] };
  warnings?: string[]; limitations?: string[];
  finding_id?: string;
};
type User = { id: string; email: string; role: 'submitter' | 'reviewer' | 'maintainer' };
const roleLabels: Record<User['role'], string> = { submitter: 'Submitter', reviewer: 'Reviewer', maintainer: 'Maintainer' };
type Finding = { id: string; status: string; impact: string; claim?: string | null };
type Transition = { fromStatus: string; toStatus: string; reason: string; createdAt: string };
type FindingComment = { id: string; body: string; status: 'visible' | 'removed'; removalReason: string | null; createdAt: string };
type Explanation = { id: string; text: string; source: 'llm' | 'template'; provider: string | null; model: string | null; templateVersion: string };
type ApiFailure = Error & { status: number };
type PublicFinding = Finding & { recipe?: string | null; datasetReleaseId?: string | null; datasetName?: string | null; filters?: Record<string, unknown>; validationStatus?: string | null; createdAt: string };
type View = 'findings' | 'datasets' | 'analyze' | 'review';

const apiBase = import.meta.env.VITE_API_URL ?? '';
// Mirrors the API's import cap (api/src/uploadPolicy.ts) so an oversized file fails
// before it is transferred instead of after the upload is rejected.
const maxUploadBytes = 100 * 1024 * 1024;

// Mirrors the API state machine so a reviewer is only offered transitions it accepts.
const nextStatuses: Record<string, string[]> = {
  Unverified: ['Pending verification', 'Rejected'],
  'Pending verification': ['In review', 'Rejected', 'Insufficient evidence'],
  'In review': ['Verified', 'Needs correction', 'Rejected', 'Insufficient evidence'],
  'Needs correction': ['Pending verification', 'Rejected'],
};

const isReviewer = (role: string | undefined) => role === 'reviewer' || role === 'maintainer';
// Test fixtures publish like any other release, so label them rather than letting a
// visitor mistake synthetic data for a government source.
const isTestFixture = (release: Dataset) => /fixture/i.test(release.name) || release.checksum === 'test-only-checksum';
const failureMessage = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
const failureStatus = (reason: unknown) => reason instanceof Error && 'status' in reason ? Number((reason as ApiFailure).status) : 0;

// S10a: with no licence information the state is unconfirmed and says so in plain
// words; publication is not blocked, so the risk is disclosed rather than hidden.
const licenceLabel = (release: Dataset): string => {
  if (release.licenceStatus === 'unconfirmed') return 'licence not confirmed — redistribution terms unknown';
  if (release.licenceStatus === 'confirmed') return 'licence confirmed';
  if (release.licenceStatus === 'not-stated') return 'licence not stated by the source';
  return release.reuseTerms ? `licence: ${release.reuseTerms}` : 'licence not confirmed — redistribution terms unknown';
};

// Join keys come from the stored schema; a release without one falls back to the
// catalog's field definitions so a key can still be chosen.
const releaseColumns = (release: Dataset): SchemaColumn[] => {
  const schema = release.metadata?.schema?.columns;
  if (schema && schema.length > 0) return schema;
  return (release.fields ?? []).map((field) => ({ name: field.name, type: field.type }));
};

const pickId = (release: Dataset): string => release.id ?? release.releaseId;

const recipeLabels: Record<string, string> = { summary: 'Summary', compare: 'Comparison', rank: 'Ranking', distribution: 'Distribution', change_over_time: 'Change over time' };
const recipeLabel = (recipe: string | null | undefined) => (recipe ? recipeLabels[recipe] ?? recipe.replace(/_/g, ' ') : 'analysis');
// A finding is checkable only if the card says what was computed, over which period,
// and whether validation passed.
const describeFindingFacts = (item: { recipe?: string | null; datasetName?: string | null; filters?: Record<string, unknown>; validationStatus?: string | null; impact: string; createdAt: string }): string => {
  const facts: string[] = [recipeLabel(item.recipe)];
  if (item.datasetName) facts.push(item.datasetName);
  const filters = item.filters ?? {};
  if (typeof filters.year === 'number') facts.push(`FY${filters.year}`);
  if (Array.isArray(filters.years)) facts.push(`FY${filters.years.join(' vs FY')}`);
  facts.push(item.validationStatus ? `validation ${item.validationStatus}` : 'validation not recorded');
  facts.push(`${item.impact} impact`);
  facts.push(new Date(item.createdAt).toLocaleDateString());
  return facts.join(' · ');
};

const statusSlug = (status: string) => status.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Status is the first thing a reader needs; the filter offers the ones that mean
// something to a visitor rather than every internal state.
const findingFilters = ['', 'Unverified', 'In review', 'Verified', 'Rejected'];
// The hash is the router: no dependency, and a section can be linked or reloaded.
const viewFromHash = (): View => {
  const name = window.location.hash.replace(/^#\/?/, '');
  return name === 'datasets' || name === 'analyze' || name === 'review' ? name : 'findings';
};

const resultText = (value: unknown): string => (value === null || value === undefined ? '—' : String(value));

// Each recipe returns its own result shape; anything unexpected falls back to raw
// JSON instead of throwing inside the render.
const renderInsightResult = (recipe: string, result: unknown): ReactNode => {
  if (recipe === 'summary' && result && typeof result === 'object' && !Array.isArray(result)) {
    const data = result as { rows?: unknown; numeric?: unknown; categorical?: unknown };
    const numeric = Array.isArray(data.numeric) ? data.numeric as Array<{ column?: unknown; min?: unknown; max?: unknown; mean?: unknown; available?: unknown }> : [];
    const categorical = Array.isArray(data.categorical) ? data.categorical as Array<{ column?: unknown; distinct?: unknown }> : [];
    return <dl className="diagnostics">
      <div><dt>Rows</dt><dd>{resultText(data.rows)}</dd></div>
      {numeric.map((entry, index) => <div key={`numeric-${index}`}><dt>{resultText(entry.column)}</dt><dd>min {resultText(entry.min)} · max {resultText(entry.max)} · mean {resultText(entry.mean)} ({resultText(entry.available)} values)</dd></div>)}
      {categorical.map((entry, index) => <div key={`categorical-${index}`}><dt>{resultText(entry.column)}</dt><dd>{resultText(entry.distinct)} distinct values</dd></div>)}
    </dl>;
  }
  if (recipe === 'rank' && Array.isArray(result)) {
    const entries = result as Array<{ label?: unknown; value?: unknown }>;
    return <ol className="insight-rank">{entries.map((entry, index) => <li key={index}>{resultText(entry.label)} — {resultText(entry.value)}</li>)}</ol>;
  }
  if (recipe === 'distribution' && result && typeof result === 'object' && !Array.isArray(result)) {
    const data = result as { field?: unknown; groups?: unknown };
    const groups = Array.isArray(data.groups) ? data.groups as Array<{ value?: unknown; count?: unknown; percentage?: unknown }> : [];
    return <>
      <p className="muted">Grouped by {resultText(data.field)}</p>
      <ul>{groups.map((group, index) => <li key={index}>{resultText(group.value)}: {resultText(group.count)} rows ({resultText(group.percentage)}%)</li>)}</ul>
    </>;
  }
  if (recipe === 'change_over_time' && Array.isArray(result)) {
    const points = result as Array<{ period?: unknown; value?: unknown; changeFromPrevious?: unknown; percentChangeFromPrevious?: unknown }>;
    return <div className="table-scroll" role="region" aria-label="Change over time result" tabIndex={0}>
      <table>
        <caption>Change over time</caption>
        <thead><tr><th scope="col">Period</th><th scope="col">Value</th><th scope="col">Change from previous</th><th scope="col">Percent change</th></tr></thead>
        <tbody>{points.map((point, index) => <tr key={index}><th scope="row">{resultText(point.period)}</th><td>{resultText(point.value)}</td><td>{resultText(point.changeFromPrevious)}</td><td>{resultText(point.percentChangeFromPrevious)}</td></tr>)}</tbody>
      </table>
    </div>;
  }
  if (recipe === 'compare' && result && typeof result === 'object' && !Array.isArray(result)) {
    const data = result as { periodA?: unknown; periodB?: unknown; valueA?: unknown; valueB?: unknown; difference?: unknown; percentChange?: unknown };
    return <div className="table-scroll" role="region" aria-label="Compare result" tabIndex={0}>
      <table>
        <caption>Compare {resultText(data.periodA)} against {resultText(data.periodB)}</caption>
        <thead><tr><th scope="col">Measure</th><th scope="col">Value</th></tr></thead>
        <tbody>
          <tr><th scope="row">{resultText(data.periodA)}</th><td>{resultText(data.valueA)}</td></tr>
          <tr><th scope="row">{resultText(data.periodB)}</th><td>{resultText(data.valueB)}</td></tr>
          <tr><th scope="row">Difference ({resultText(data.periodB)} − {resultText(data.periodA)})</th><td>{resultText(data.difference)}</td></tr>
          <tr><th scope="row">Percent change</th><td>{resultText(data.percentChange)}</td></tr>
        </tbody>
      </table>
    </div>;
  }
  return <details><summary>Raw result JSON</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>;
};

// Pagination is opt-in: an untouched control sends no query parameter, so the
// API default response shape is preserved. Filters follow the same rule.
const pageQuery = (limit: string, offset: string, filters: Record<string, string> = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  return params.toString() ? `?${params}` : '';
};

const describeFilters = (filters: Record<string, unknown>) => {
  const labels: string[] = [];
  if (typeof filters.recipe === 'string') labels.push(`recipe: ${filters.recipe}`);
  if (typeof filters.year === 'number') labels.push(`year: ${filters.year}`);
  if (typeof filters.status === 'string') labels.push(`status: ${filters.status}`);
  if (Array.isArray(filters.compareYears)) labels.push(`compare: ${filters.compareYears.join(' vs ')}`);
  return labels.length ? labels.join(' · ') : 'no filters';
};

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { credentials: 'same-origin', ...init });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Request failed.';
    const failure = new Error(code) as ApiFailure;
    failure.status = response.status;
    throw failure;
  }
  return body as T;
}

function App() {
  const [dataset, setDataset] = useState<Dataset>();
  const [recipe, setRecipe] = useState('summary');
  const [year, setYear] = useState('');
  const [status, setStatus] = useState('');
  const [compareYears, setCompareYears] = useState<[string, string]>(['2020', '2021']);
  const [analysis, setAnalysis] = useState<Analysis>();
  const [matchingRows, setMatchingRows] = useState<number>();
  const [previewError, setPreviewError] = useState('');
  const [error, setError] = useState('');
  const [validationFailure, setValidationFailure] = useState<{ status: string; checks: string[]; reproducibility_status?: string }>();
  const [loading, setLoading] = useState(false);
  const [joined, setJoined] = useState<JoinedAnalysis>();
  const [joinedError, setJoinedError] = useState('');
  const [joinedStatus, setJoinedStatus] = useState('');
  const [joining, setJoining] = useState(false);
  const [finding, setFinding] = useState<Finding>();
  const [findingError, setFindingError] = useState('');
  const [claim, setClaim] = useState('');
  const [user, setUser] = useState<User>();
  const [sessionReady, setSessionReady] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [email, setEmail] = useState('');
  const [requestingLink, setRequestingLink] = useState(false);
  const [sessionMessage, setSessionMessage] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [queue, setQueue] = useState<Finding[]>([]);
  const [queueReady, setQueueReady] = useState(false);
  const [queueError, setQueueError] = useState('');
  const [reviewStatus, setReviewStatus] = useState('');
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, { status: string; reason: string }>>({});
  const [selected, setSelected] = useState<Finding>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [history, setHistory] = useState<Transition[]>([]);
  const [comments, setComments] = useState<FindingComment[]>([]);
  const [explanation, setExplanation] = useState<Explanation>();
  const [commentBody, setCommentBody] = useState('');
  const [removalReasons, setRemovalReasons] = useState<Record<string, string>>({});
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [releases, setReleases] = useState<Dataset[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetsError, setDatasetsError] = useState('');
  const [datasetQuery, setDatasetQuery] = useState('');
  const [showAllDatasets, setShowAllDatasets] = useState(false);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectorsError, setConnectorsError] = useState('');
  const [checkResults, setCheckResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [checkingId, setCheckingId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [leftKey, setLeftKey] = useState('');
  const [rightKey, setRightKey] = useState('');
  const [periodA, setPeriodA] = useState('');
  const [periodB, setPeriodB] = useState('');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResponse>();
  const [runError, setRunError] = useState('');
  const [runClaim, setRunClaim] = useState('');
  const [savingRun, setSavingRun] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [saveError, setSaveError] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogAgency, setCatalogAgency] = useState('');
  const [catalogFreshness, setCatalogFreshness] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState('');
  const [viewsStatus, setViewsStatus] = useState('');
  const [viewsError, setViewsError] = useState('');
  const [viewsLimit, setViewsLimit] = useState('');
  const [viewsOffset, setViewsOffset] = useState('');
  const [queueLimit, setQueueLimit] = useState('25');
  const [queueOffset, setQueueOffset] = useState('');
  const [queueFilterStatus, setQueueFilterStatus] = useState('');
  const [queueFilterImpact, setQueueFilterImpact] = useState('');
  const [queueFilterQuery, setQueueFilterQuery] = useState('');
  const [uploadFile, setUploadFile] = useState<File>();
  const [uploadName, setUploadName] = useState('');
  const [uploadDraft, setUploadDraft] = useState<ImportDraft>();
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [publishForm, setPublishForm] = useState({ reason: '', publisher: '', sourceUrl: '', license: '', fiscalYears: '', fields: '', limitations: '' });
  const [publishStatus, setPublishStatus] = useState('');
  const [publishError, setPublishError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [view, setView] = useState<View>(viewFromHash);
  const [publicFindings, setPublicFindings] = useState<PublicFinding[]>([]);
  const [publicFilter, setPublicFilter] = useState('');
  const [publicHasMore, setPublicHasMore] = useState(false);
  const [publicLoadingMore, setPublicLoadingMore] = useState(false);
  const [publicReady, setPublicReady] = useState(false);
  const [publicError, setPublicError] = useState('');
  const reviewer = isReviewer(user?.role);
  const maintainer = user?.role === 'maintainer';
  const agencyName = (id: string | null | undefined) => agencies.find((item) => item.id === id)?.name ?? id ?? 'Unlisted agency';
  // Queue filters ride along with pagination; untouched controls add no parameter.
  const queueQuery = () => pageQuery(queueLimit, queueOffset, { status: queueFilterStatus, impact: queueFilterImpact, q: queueFilterQuery.trim() });
  // Selection order is join order: the first pick is the left side of the join.
  // A reader picks one or two of a few hundred releases, so the list is searchable, the
  // verified release leads, test fixtures sink to the back, and a page of fifteen keeps it
  // scannable. A selected release is never hidden.
  const datasetMatches = (release: Dataset) => {
    const query = datasetQuery.trim().toLowerCase();
    if (!query) return true;
    return [release.name, release.publisher, release.agencyId ?? ''].some((value) => value.toLowerCase().includes(query));
  };
  const visibleDatasets = datasets
    .filter((release) => datasetMatches(release) || selectedIds.includes(pickId(release)))
    .sort((left, right) => {
      // A release with no stored rows cannot run, so it must not occupy the first page.
      const usable = (release: Dataset) => ((release.rowCount ?? 0) > 0 ? 0 : 1);
      const testData = (release: Dataset) => (isTestFixture(release) ? 1 : 0);
      return usable(left) - usable(right) || testData(left) - testData(right) || left.name.localeCompare(right.name);
    });
  const shownDatasets = showAllDatasets ? visibleDatasets : visibleDatasets.slice(0, 15);
  const selectedReleases = selectedIds.map((id) => datasets.find((item) => pickId(item) === id)).filter((item): item is Dataset => item !== undefined);
  const runEvidenceId = runResult?.insights.find((insight) => insight.evidence_id)?.evidence_id ?? '';
  const canRun = selectedReleases.length > 0 && (selectedReleases.length === 1 || (Boolean(leftKey) && Boolean(rightKey)));

  // Demo-only: swap identity without the email round trip, then land where that role
  // works so a reader judging the project never stalls on an empty screen.
  async function switchDemoRole(role: User['role']) {
    setSessionError('');
    try {
      const body = await apiRequest<{ user: User }>('/api/v1/auth/demo-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
      setUser(body.user);
      window.location.hash = role === 'submitter' ? '#/findings' : '#/review';
    } catch (reason) { setSessionError(failureMessage(reason, 'Demo role switch failed.')); }
  }

  async function loadMoreFindings() {
    setPublicLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: String(publicPageSize), offset: String(publicFindings.length) });
      if (publicFilter) query.set('status', publicFilter);
      const body = await apiRequest<{ findings: PublicFinding[] }>(`/api/v1/findings?${query}`);
      setPublicFindings((current) => [...current, ...body.findings]);
      setPublicHasMore(body.findings.length === publicPageSize);
    } catch (reason) { setPublicError(failureMessage(reason, 'The findings list is currently unavailable.')); }
    finally { setPublicLoadingMore(false); }
  }

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // A page of twenty keeps the landing readable; more is one click away. The API caps
  // the whole list at 100, so this never becomes an unbounded read.
  const publicPageSize = 20;
  useEffect(() => {
    if (view !== 'findings') return;
    let active = true;
    const query = new URLSearchParams({ limit: String(publicPageSize) });
    if (publicFilter) query.set('status', publicFilter);
    setPublicError('');
    fetch(`${apiBase}/api/v1/findings?${query}`).then(async (response) => {
      const body = await response.json() as { findings?: PublicFinding[]; error?: string };
      if (!response.ok) throw new Error('The findings list is currently unavailable.');
      return body.findings ?? [];
    }).then((list) => { if (active) { setPublicFindings(list); setPublicHasMore(list.length === publicPageSize); } })
      .catch((reason: unknown) => { if (active) { setPublicFindings([]); setPublicHasMore(false); setPublicError(failureMessage(reason, 'The findings list is currently unavailable.')); } })
      .finally(() => { if (active) setPublicReady(true); });
    return () => { active = false; };
  }, [view, publicFilter]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (catalogQuery.trim()) params.set('q', catalogQuery.trim());
    if (catalogAgency) params.set('agency', catalogAgency);
    if (catalogFreshness) params.set('freshness', catalogFreshness);
    const query = params.toString() ? `?${params}` : '';
    // shortcut: one request per keystroke; debounce when the catalog outgrows a page.
    fetch(`${apiBase}/api/v1/datasets${query}`).then(async (response) => {
      const body = await response.json() as { datasets?: Dataset[]; error?: string; parameter?: string };
      if (!response.ok) throw new Error(body.error === 'invalid_filter' ? `The ${body.parameter ?? 'filter'} filter is not valid.` : 'The catalog is currently unavailable.');
      return body.datasets ?? [];
    }).then((list) => {
      setReleases(list);
      setCatalogError('');
      // The featured release stays the verified one; filtering only narrows the list.
      if (!query) setDataset(list.find((item: Dataset) => item.publisher === 'BetterGovPH') ?? list[0]);
    }).catch((reason: unknown) => { setReleases([]); setCatalogError(failureMessage(reason, 'The catalog is currently unavailable.')); });
  }, [catalogQuery, catalogAgency, catalogFreshness]);

  // MVP-E loads its own list once so catalog search never reshuffles the selection.
  useEffect(() => {
    fetch(`${apiBase}/api/v1/connectors`).then(async (response) => {
      const body = await response.json() as { connectors?: Connector[] };
      if (!response.ok) throw new Error('Sources are currently unavailable.');
      return body.connectors ?? [];
    }).then((list) => { setConnectors(list); setConnectorsError(''); })
      .catch((reason: unknown) => { setConnectors([]); setConnectorsError(failureMessage(reason, 'Sources are currently unavailable.')); });
  }, []);

  useEffect(() => {
    fetch(`${apiBase}/api/v1/datasets`).then(async (response) => {
      const body = await response.json() as { datasets?: Dataset[] };
      if (!response.ok) throw new Error('The catalog is currently unavailable.');
      return body.datasets ?? [];
    }).then((list) => { setDatasets(list); setDatasetsError(''); })
      .catch((reason: unknown) => { setDatasets([]); setDatasetsError(failureMessage(reason, 'The catalog is currently unavailable.')); });
  }, []);

  useEffect(() => {
    fetch(`${apiBase}/api/v1/agencies`).then((response) => { if (!response.ok) throw new Error('Agencies unavailable'); return response.json(); }).then((body: { agencies?: Agency[] }) => setAgencies(body.agencies ?? [])).catch(() => setAgencies([]));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (recipe === 'compare') params.set('years', compareYears.join(','));
    else if (year) params.set('year', year);
    if (status) params.set('status', status);
    const query = params.toString() ? `?${params}` : '';
    fetch(`${apiBase}/api/v1/datasets/bettergov-gaa-coverage-2026-11-07/preview${query}`).then((response) => { if (!response.ok) throw new Error('Preview unavailable'); return response.json(); }).then((body: { matching_rows?: number }) => { setMatchingRows(body.matching_rows); setPreviewError(''); }).catch(() => { setMatchingRows(undefined); setPreviewError('Matching-row preview is unavailable.'); });
  }, [year, status, recipe, compareYears]);

  // Read once directly: a signed-out visitor is a 401, and that response still has to
  // tell the page whether demo mode is on or the role switcher could never appear.
  useEffect(() => {
    fetch(`${apiBase}/api/v1/auth/me`, { credentials: 'same-origin' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { user?: User; demo?: boolean };
        setDemoMode(body.demo === true);
        if (response.ok && body.user) setUser(body.user);
        else if (response.status !== 401) setSessionError('Account service unavailable.');
      })
      .catch(() => setSessionError('Account service unavailable.'))
      .finally(() => setSessionReady(true));
  }, []);

  useEffect(() => {
    if (!reviewer) return;
    let active = true;
    setQueueReady(false); setQueueError('');
    apiRequest<{ findings: Finding[] }>(`/api/v1/review/queue${queueQuery()}`)
      .then((body) => { if (active) setQueue(body.findings); })
      .catch((reason: unknown) => { if (active) setQueueError(failureMessage(reason, 'Review queue unavailable.')); })
      .finally(() => { if (active) setQueueReady(true); });
    return () => { active = false; };
  }, [reviewer, queueLimit, queueOffset, queueFilterStatus, queueFilterImpact, queueFilterQuery]);

  useEffect(() => {
    if (!user) { setSavedViews([]); setViewsStatus(''); return; }
    let active = true;
    setViewsStatus('Loading saved views…');
    apiRequest<{ views: SavedView[] }>(`/api/v1/saved-views${pageQuery(viewsLimit, viewsOffset)}`)
      .then((body) => {
        if (!active) return;
        setSavedViews(body.views); setViewsError('');
        setViewsStatus(`${body.views.length} saved view${body.views.length === 1 ? '' : 's'}${viewsLimit ? ` · limit ${viewsLimit}` : ' · unpaginated'}${viewsOffset ? ` · offset ${viewsOffset}` : ''}`);
      })
      .catch((reason: unknown) => { if (active) { setViewsStatus(''); setViewsError(failureMessage(reason, 'Saved views unavailable.')); } });
    return () => { active = false; };
  }, [user, viewsLimit, viewsOffset]);

  async function requestLink(event: FormEvent) {
    event.preventDefault();
    setSessionError(''); setSessionMessage(''); setRequestingLink(true);
    try {
      await apiRequest('/api/v1/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      setSessionMessage('Sign-in link sent. There is no mail transport yet, so the link appears in the API log.');
    } catch (reason) {
      setSessionError(failureMessage(reason, 'Could not request a sign-in link.'));
    } finally { setRequestingLink(false); }
  }

  async function signOut() {
    setSessionError('');
    try { await apiRequest('/api/v1/auth/logout', { method: 'POST' }); }
    catch (reason) { setSessionError(failureMessage(reason, 'Could not sign out.')); return; }
    setUser(undefined); setQueue([]); setQueueReady(false); setReviewStatus(''); setSelected(undefined); setHistory([]); setComments([]); setExplanation(undefined); setCommentBody('');
  }

  async function loadFinding(id: string) {
    const path = encodeURIComponent(id);
    setSelected(undefined); setHistory([]); setComments([]); setExplanation(undefined); setDetailError(''); setDetailLoading(true);
    try {
      const [detail, decisionHistory, thread, latestExplanation] = await Promise.all([
        apiRequest<Finding>(`/api/v1/findings/${path}`),
        apiRequest<{ transitions: Transition[] }>(`/api/v1/findings/${path}/history`),
        apiRequest<{ comments: FindingComment[] }>(`/api/v1/findings/${path}/comments`),
        apiRequest<{ explanation: Explanation | null }>(`/api/v1/findings/${path}/explanation`),
      ]);
      setSelected(detail); setHistory(decisionHistory.transitions); setComments(thread.comments); setExplanation(latestExplanation.explanation ?? undefined);
    } catch (reason) {
      setDetailError(failureMessage(reason, 'Finding details unavailable.'));
    } finally { setDetailLoading(false); }
  }

  async function saveFinding() {
    if (!analysis?.evidence_id) return;
    setLoading(true); setFindingError('');
    try {
      const created = await apiRequest<Finding>('/api/v1/findings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ evidence_id: analysis.evidence_id, claim }) });
      setFinding(created);
      await loadFinding(created.id);
    } catch (reason) {
      setFindingError(failureStatus(reason) === 401 ? 'Sign in first to save a finding.' : failureMessage(reason, 'Could not save the finding.'));
    } finally { setLoading(false); }
  }

  async function decide(event: FormEvent, item: Finding) {
    event.preventDefault();
    const draft = decisionDrafts[item.id];
    if (!draft?.status) return;
    setQueueError(''); setReviewStatus('Recording decision…');
    try {
      const result = await apiRequest<{ conflict?: { statuses: string[] } }>(`/api/v1/findings/${encodeURIComponent(item.id)}/decisions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: draft.status, reason: draft.reason }),
      });
      setDecisionDrafts((current) => ({ ...current, [item.id]: { status: '', reason: '' } }));
      setReviewStatus(result.conflict ? `Reviewers disagreed (${result.conflict.statuses.join(' vs ')}); both positions are recorded.` : 'Decision recorded.');
      await loadFinding(item.id);
      try {
        const refreshed = await apiRequest<{ findings: Finding[] }>(`/api/v1/review/queue${queueQuery()}`);
        setQueue(refreshed.findings);
      } catch (cause) { setQueueError(failureMessage(cause, 'Review queue unavailable.')); }
    } catch (reason) {
      setReviewStatus(''); setQueueError(failureMessage(reason, 'Decision failed.'));
    }
  }

  async function submitComment(event: FormEvent) {
    event.preventDefault();
    if (!selected || !commentBody.trim()) return;
    setDetailError('');
    try {
      const created = await apiRequest<FindingComment>(`/api/v1/findings/${encodeURIComponent(selected.id)}/comments`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: commentBody }),
      });
      setComments((current) => [...current, created]); setCommentBody('');
    } catch (reason) { setDetailError(failureMessage(reason, 'Could not post the comment.')); }
  }

  async function generateExplanation() {
    if (!selected) return;
    setDetailError('');
    try {
      await apiRequest(`/api/v1/findings/${encodeURIComponent(selected.id)}/explanation`, { method: 'POST' });
      await loadFinding(selected.id);
    } catch (reason) { setDetailError(failureMessage(reason, 'Could not generate the explanation.')); }
  }

  async function removeComment(event: FormEvent, comment: FindingComment) {
    event.preventDefault();
    const reason = removalReasons[comment.id] ?? '';
    if (!reason.trim()) return;
    setDetailError('');
    try {
      await apiRequest(`/api/v1/comments/${encodeURIComponent(comment.id)}/removal`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
      });
      setComments((current) => current.map((item) => item.id === comment.id ? { ...item, status: 'removed', body: '', removalReason: reason } : item));
      setRemovalReasons((current) => ({ ...current, [comment.id]: '' }));
    } catch (cause) { setDetailError(failureMessage(cause, 'Could not remove the comment.')); }
  }

  async function saveView(event: FormEvent) {
    event.preventDefault();
    if (!dataset || !viewName.trim()) return;
    setViewsError(''); setViewsStatus('Saving view…');
    const filters: Record<string, unknown> = { recipe };
    if (year) filters.year = Number(year);
    if (status) filters.status = status;
    if (recipe === 'compare') filters.compareYears = compareYears;
    try {
      const view = await apiRequest<SavedView>('/api/v1/saved-views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: viewName.trim(), datasetReleaseId: dataset.releaseId, filters }) });
      setSavedViews((current) => [view, ...current]); setViewName(''); setViewsStatus(`Saved view “${view.name}”.`);
    } catch (reason) { setViewsStatus(''); setViewsError(failureMessage(reason, 'Could not save the view.')); }
  }

  function restoreView(view: SavedView) {
    const filters = view.filters as { recipe?: unknown; year?: unknown; status?: unknown; compareYears?: unknown };
    setRecipe(typeof filters.recipe === 'string' ? filters.recipe : 'summary');
    setYear(typeof filters.year === 'number' ? String(filters.year) : '');
    setStatus(typeof filters.status === 'string' ? filters.status : '');
    if (Array.isArray(filters.compareYears) && filters.compareYears.length === 2) setCompareYears([String(filters.compareYears[0]), String(filters.compareYears[1])]);
    setViewsStatus(`Restored “${view.name}”.`);
  }

  async function registerUpload(event: FormEvent) {
    event.preventDefault();
    if (!uploadFile) return;
    if (uploadFile.size > maxUploadBytes) {
      setUploadError(`That file is ${(uploadFile.size / 1024 / 1024).toFixed(1)} MB; the limit is 100 MB.`);
      return;
    }
    setUploadError(''); setUploadDraft(undefined); setPublishStatus(''); setPublishError(''); setUploadStatus('Uploading and validating…');
    try {
      const response = await fetch(`${apiBase}/api/v1/imports/register?filename=${encodeURIComponent(uploadFile.name)}&name=${encodeURIComponent(uploadName)}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': uploadFile.type || 'application/octet-stream' }, body: uploadFile,
      });
      const body = await response.json().catch(() => ({})) as ImportDraft & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Upload failed (${response.status}).`);
      setUploadDraft(body); setUploadStatus(`Draft ${body.id} is ${body.status}.`);
    } catch (reason) { setUploadStatus(''); setUploadError(failureMessage(reason, 'Upload failed.')); }
  }

  async function publishDraft(event: FormEvent, draft: ImportDraft) {
    event.preventDefault();
    setPublishError(''); setPublishStatus(''); setPublishing(true);
    const fiscalYears = publishForm.fiscalYears.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value));
    const fields = publishForm.fields.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, type, ...description] = line.split(':');
      return { name: name.trim(), type: type?.trim() || 'string', description: description.join(':').trim() };
    });
    const limitations = publishForm.limitations.split('\n').map((line) => line.trim()).filter(Boolean);
    try {
      const result = await apiRequest<{ release_id: string }>(`/api/v1/imports/${encodeURIComponent(draft.id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: publishForm.reason, metadata: { publisher: publishForm.publisher, sourceUrl: publishForm.sourceUrl, license: publishForm.license, coverage: { fiscalYears }, fields, limitations } }),
      });
      setPublishStatus(`Published as ${result.release_id}.`);
      // The panel must not keep saying "validated" after publishing, and the new release
      // has to appear in the picker without a reload.
      setUploadDraft({ ...draft, status: 'published' });
      setUploadStatus(`${draft.name} is published as ${result.release_id}. It is now available under Datasets.`);
      setPublishForm({ reason: '', publisher: '', sourceUrl: '', license: '', fiscalYears: '', fields: '', limitations: '' });
      fetch(`${apiBase}/api/v1/datasets`).then(async (response) => {
        const body = await response.json() as { datasets?: Dataset[] };
        if (response.ok && body.datasets) setDatasets(body.datasets);
      }).catch(() => { /* the catalog keeps its previous list; the publish itself succeeded */ });
    } catch (reason) { setPublishError(failureMessage(reason, 'Could not publish the draft.')); }
    finally { setPublishing(false); }
  }

  async function runCuratedJoin() {
    setJoining(true); setJoinedError(''); setJoined(undefined);
    setJoinedStatus('Running the curated join with a deterministic rerun check…');
    try {
      const body = await apiRequest<JoinedAnalysis>('/api/v1/join/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      setJoined(body);
      setJoinedStatus(`Curated join finished: ${body.matched_rows ?? 0} matched rows.`);
    } catch (reason) {
      setJoinedStatus('');
      setJoinedError(failureStatus(reason) === 404 ? 'Curated relationship not found.' : failureMessage(reason, 'Curated join failed.'));
    } finally { setJoining(false); }
  }

  function toggleDataset(id: string) {
    const next = selectedIds.includes(id) ? selectedIds.filter((item) => item !== id)
      : selectedIds.length < 2 ? [...selectedIds, id] : selectedIds;
    setSelectedIds(next);
    // A key chosen for a side that is no longer selected would join the wrong columns.
    const stillValid = (release: Dataset | undefined, key: string) =>
      Boolean(key) && release !== undefined && releaseColumns(release).some((column) => column.name === key);
    if (!stillValid(datasets.find((item) => pickId(item) === next[0]), leftKey)) setLeftKey('');
    if (!stillValid(datasets.find((item) => pickId(item) === next[1]), rightKey)) setRightKey('');
  }

  async function checkConnector(id: string) {
    setCheckingId(id);
    setCheckResults((current) => ({ ...current, [id]: { ok: true, text: 'Checking…' } }));
    try {
      const response = await fetch(`${apiBase}/api/v1/connectors/${encodeURIComponent(id)}/check`, { method: 'POST', credentials: 'same-origin' });
      const body = await response.json().catch(() => ({})) as { status?: string; dataset_count?: number | null; http_status?: number | null; message?: string; error?: string };
      // A 502 failure carries its message in the same shape, so it is shown verbatim.
      const text = body.message || (body.status === 'ok'
        ? `ok — ${body.dataset_count ?? 0} datasets · HTTP ${body.http_status ?? 'unknown'}`
        : body.error || `check failed (HTTP ${response.status})`);
      setCheckResults((current) => ({ ...current, [id]: { ok: response.ok && body.status !== 'failed', text } }));
    } catch {
      setCheckResults((current) => ({ ...current, [id]: { ok: false, text: 'The check could not reach the API.' } }));
    } finally { setCheckingId(''); }
  }

  async function submitRun(event: FormEvent) {
    event.preventDefault();
    if (!canRun) return;
    setRunning(true); setRunError(''); setRunResult(undefined); setSaveStatus(''); setSaveError(''); setRunClaim('');
    const payload: { release_ids: string[]; left_key?: string; right_key?: string; options?: Record<string, string> } = { release_ids: selectedReleases.map(pickId) };
    if (selectedReleases.length === 2) { payload.left_key = leftKey; payload.right_key = rightKey; }
    const options: Record<string, string> = {};
    if (periodA) options.periodA = periodA;
    if (periodB) options.periodB = periodB;
    if (Object.keys(options).length > 0) payload.options = options;
    try {
      const response = await fetch(`${apiBase}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({})) as { message?: unknown; error?: unknown };
      if (!response.ok) {
        setRunError(typeof body.message === 'string' && body.message
          ? body.message
          : typeof body.error === 'string' && body.error ? body.error : `The run was refused (HTTP ${response.status}).`);
        return;
      }
      setRunResult(body as RunResponse);
    } catch {
      setRunError('The run could not reach the API.');
    } finally { setRunning(false); }
  }

  async function saveRunFinding() {
    if (!runEvidenceId) return;
    setSavingRun(true); setSaveError(''); setSaveStatus('');
    try {
      const created = await apiRequest<Finding>('/api/v1/findings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ evidence_id: runEvidenceId, claim: runClaim }) });
      setSaveStatus(`Saved ${created.id} as ${created.status}.`);
    } catch (reason) {
      setSaveError(failureStatus(reason) === 401 ? 'Sign in first to save a finding.' : failureMessage(reason, 'Could not save the finding.'));
    } finally { setSavingRun(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(''); setAnalysis(undefined); setValidationFailure(undefined);
    try {
      const response = await fetch(`${apiBase}/api/v1/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipe, ...(recipe === 'compare' ? { compare_years: compareYears.map(Number) } : year ? { year: Number(year) } : {}), ...(status ? { status } : {}) }) });
      // The error shape carries validation details the success body does not.
      const body = await response.json() as Analysis & { error?: string; validation?: { status: string; checks: string[] }; reproducibility_status?: string };
      if (!response.ok) { if (body.validation) setValidationFailure({ ...body.validation, reproducibility_status: body.reproducibility_status }); throw new Error(body.error ?? 'Analysis failed.'); }
      setAnalysis(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Analysis failed.'); }
    finally { setLoading(false); }
  }

  const tabs: Array<{ key: View; label: string }> = [
    { key: 'findings', label: 'Findings' },
    { key: 'datasets', label: 'Datasets' },
    { key: 'analyze', label: 'Analyse' },
    ...(user ? [{ key: 'review' as View, label: reviewer ? 'Review' : 'Your work' }] : []),
  ];

  return <div className="app">
    <header className="topbar">
      <div className="brand">
        <a className="wordmark" href="#/findings">SaySight</a>
        <p className="tagline">Public datasets, checked by people.</p>
      </div>
      <nav className="tabs" aria-label="Sections">
        {tabs.map((tab) => <a key={tab.key} href={`#/${tab.key}`} className={view === tab.key ? 'tab tab-active' : 'tab'} aria-current={view === tab.key ? 'page' : undefined}>{tab.label}</a>)}
      </nav>
      <div className="account">
        {demoMode && <span className="demo-badge">Demo mode</span>}
        {!sessionReady ? <span className="muted">Checking account…</span> : demoMode ? <>
          <div className="role-switch" role="group" aria-label="Demo role">
            {(['submitter', 'reviewer', 'maintainer'] as const).map((role) => <button key={role} type="button" className={user?.role === role ? 'chip chip-active' : 'chip'} aria-pressed={user?.role === role} onClick={() => switchDemoRole(role)}>{roleLabels[role]}</button>)}
          </div>
          {!user && <p role="status" className="muted">No role selected. Pick one to explore.</p>}
        </> : user ? <>
          <p role="status" className="muted">Signed in as <strong>{user.email}</strong> ({user.role})</p>
          <Button type="button" variant="outline" size="sm" onClick={signOut}>Sign out</Button>
        </> : <details className="signin">
          <summary>Sign in</summary>
          <form onSubmit={requestLink}>
            <div className="form-field"><Label htmlFor="sign-in-email">Email for a sign-in link</Label><Input id="sign-in-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
            <Button type="submit" variant="primary" size="md" isLoading={requestingLink} disabled={requestingLink}>{requestingLink ? 'Sending…' : 'Send sign-in link'}</Button>
          </form>
          {sessionMessage && <p role="status" className="muted">{sessionMessage}</p>}
        </details>}
        {sessionError && <p role="alert" className="error">{sessionError}</p>}
      </div>
    </header>
    <main>
      {view === 'findings' && <section className="view" aria-labelledby="findings-heading">
        <div className="view-head">
          <h1 id="findings-heading">Public findings</h1>
          <p className="lede">Each finding is one analysis of a cataloged dataset, stated as a claim you can check. The status shows how far human review has gone, and the evidence behind it does not change after the fact.</p>
        </div>
        <div className="status-filter" role="group" aria-label="Filter findings by status">
          {findingFilters.map((value) => <button key={value || 'all'} type="button" className={publicFilter === value ? 'chip chip-active' : 'chip'} aria-pressed={publicFilter === value} onClick={() => setPublicFilter(value)}>{value || 'All'}</button>)}
        </div>
        {publicError && <p role="alert" className="error">{publicError}</p>}
        {!publicReady && !publicError && <p className="muted">Loading findings…</p>}
        {publicReady && !publicError && publicFindings.length === 0 && <div className="empty">
          <h2>{publicFilter ? `No findings are ${publicFilter.toLowerCase()} right now.` : 'No findings have been published yet.'}</h2>
          <p>Anyone can produce one: pick a cataloged dataset, run a deterministic analysis, and save the result as a finding. It starts Unverified, and a reviewer decides what happens next.</p>
          <a className="cta" href="#/analyze">Analyse a dataset</a>
        </div>}
        {publicFindings.length > 0 && <ul className="finding-list">
          {publicFindings.map((item) => <li key={item.id} className="finding-card">
            <div className="finding-top">
              <span className={`pill pill-${statusSlug(item.status)}`}>{item.status}</span>
              {isTestFixture(datasets.find((release) => pickId(release) === item.datasetReleaseId) ?? ({ name: item.datasetReleaseId ?? '' } as Dataset)) && <span className="badge">Test data</span>}
              <span className="finding-meta">{describeFindingFacts(item)}</span>
            </div>
            <p className="claim">{item.claim || 'No claim was recorded for this finding.'}</p>
            <a href={`${apiBase}/api/v1/findings/${encodeURIComponent(item.id)}/page`}>Read the finding and its evidence</a>
          </li>)}
        </ul>}
        {publicHasMore && <div className="more"><Button type="button" variant="outline" size="md" onClick={loadMoreFindings} isLoading={publicLoadingMore} disabled={publicLoadingMore}>{publicLoadingMore ? 'Loading…' : 'Show more findings'}</Button></div>}
        <div className="promise">
          <h2>What the status words mean</h2>
          <dl>
            <div><dt>Unverified</dt><dd>Submitted; nobody has reviewed it yet.</dd></div>
            <div><dt>In review</dt><dd>A reviewer is checking the evidence against the cited release.</dd></div>
            <div><dt>Verified</dt><dd>A reviewer confirmed the source, release, calculation, and stated interpretation.</dd></div>
            <div><dt>Rejected</dt><dd>A reviewer recorded why the finding does not hold.</dd></div>
            <div><dt>Insufficient evidence</dt><dd>The evidence could not settle the claim either way.</dd></div>
          </dl>
          <p className="muted">Verification is not proof of wrongdoing or of cause. It means the stated calculation was checked against the cited release under this process.</p>
        </div>
      </section>}
      {view === 'datasets' && <>
        <div className="view-head">
          <h1>Datasets</h1>
          <p className="lede">Choose a release to analyse on its own, or two releases to join on a key you pick. Every entry lists its agency, freshness, and licence state before you commit to it.</p>
        </div>
    <section aria-labelledby="dataset-heading">
      <Card className="card">
      <h2 id="dataset-heading">Featured release</h2>
      <p className="muted">One verified release is the working dataset. Other entries are published releases and test fixtures; each lists its agency, region, and freshness so you can judge it before using it.</p>
      <div className="filter-row">
        <div className="form-field"><Label htmlFor="catalog-query">Search releases</Label><Input id="catalog-query" type="search" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="Name, publisher, release, or agency" /></div>
        <div className="form-field"><Label htmlFor="catalog-agency">Agency</Label><select id="catalog-agency" value={catalogAgency} onChange={(event) => setCatalogAgency(event.target.value)}><option value="">All agencies</option>{agencies.map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}</select></div>
        <div className="form-field"><Label htmlFor="catalog-freshness">Freshness</Label><select id="catalog-freshness" value={catalogFreshness} onChange={(event) => setCatalogFreshness(event.target.value)}><option value="">All freshness</option><option value="current">Current</option><option value="possibly_stale">Possibly stale</option><option value="stale">Stale</option></select></div>
      </div>
      {catalogError && <p role="alert" className="error">{catalogError}</p>}
      {dataset ? <>
        <h3>{dataset.name}</h3>
        <p>Publisher: {dataset.publisher} · Terms: {dataset.reuseTerms}</p>
        <p><a href={dataset.sourceUrl}>View source metadata</a> · Release: <code>{dataset.releaseId}</code></p>
        <p className="muted">Checksum: <code>{dataset.checksum}</code></p>
        <ul>{dataset.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        <details>
          <summary>Dataset details and fields</summary>
          <p>Fiscal years covered: {dataset.coverage.fiscalYears[0]}–{dataset.coverage.fiscalYears.at(-1)} ({dataset.coverage.fiscalYears.length} years)</p>
          <div className="table-scroll" role="region" aria-label="Field definitions" tabIndex={0}>
          <table>
            <caption>Field definitions</caption>
            <thead><tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Unit</th><th scope="col">Description</th></tr></thead>
            <tbody>{dataset.fields.map((field) => <tr key={field.name}><th scope="row">{field.name}</th><td>{field.type}</td><td>{field.unit ?? '—'}</td><td>{field.description}</td></tr>)}</tbody>
          </table>
          </div>
        </details>
        <details className="release-details">
          <summary>Releases and source freshness ({releases.length})</summary>
          {releases.length === 0 ? <p className="muted">No releases listed.</p> : <ul className="release-list">{releases.map((release) => <li key={release.id ?? release.releaseId}>
          <strong>{release.name}</strong>{isTestFixture(release) && <span className="badge">Test data</span>}
          <p>Agency: {agencyName(release.agencyId)} · Region: {release.region || '—'} · Freshness: <strong>{release.freshnessStatus || 'unknown'}</strong></p>
          <p className="muted">Last checked: {release.lastCheckedAt ? new Date(release.lastCheckedAt).toLocaleDateString() : '—'}</p>
        </li>)}</ul>}
        </details>
      </> : <p>Loading catalog…</p>}
      </Card>
    </section>
    <section aria-labelledby="sources-heading">
      <Card className="card">
      <h2 id="sources-heading">Sources</h2>
      <p className="muted">Every portal connector SaySight reads, with its kind and the latest check recorded in the connector log. An unreadable portal stays listed with its status and reason instead of disappearing.</p>
      {connectorsError && <p role="alert" className="error">{connectorsError}</p>}
      {connectors.length === 0 && !connectorsError && <p className="muted">Loading sources…</p>}
      <ul className="connector-list">
        {connectors.map((connector) => {
          const check = connector.last_check ?? connector.lastCheck;
          const result = checkResults[connector.id];
          return <li key={connector.id}>
            <h3>{connector.name} <span className="badge">{connector.kind === 'scraped' ? 'Scraped' : 'API'}</span></h3>
            {connector.externalBenchmark && <p className="muted">External comparison data — not Philippine government data.</p>}
            <p>Last check: {check
              ? <><strong>{check.status ?? 'unknown status'}</strong>{check.datasetCount !== null && check.datasetCount !== undefined && <> · {check.datasetCount} datasets</>}{typeof check.httpStatus === 'number' && <> · HTTP {check.httpStatus}</>}{check.message && <> — {check.message}</>}</>
              : 'none recorded'}</p>
            {maintainer && <Button type="button" variant="outline" size="md" onClick={() => checkConnector(connector.id)} disabled={Boolean(checkingId)} isLoading={checkingId === connector.id}>{checkingId === connector.id ? 'Checking…' : 'Check'}</Button>}
            {result && <p role={result.ok ? 'status' : 'alert'} className={result.ok ? 'muted' : 'error'}>{result.text}</p>}
          </li>;
        })}
      </ul>
      </Card>
    </section>
    <section aria-labelledby="picks-heading">
      <Card className="card">
      <h2 id="picks-heading">Choose releases</h2>
      <p className="muted">Pick one release to analyse on its own, or two releases to join. At most two are selected at a time; click a selected release again to drop it.</p>
      {datasetsError && <p role="alert" className="error">{datasetsError}</p>}
      {datasets.length === 0 && !datasetsError && <p className="muted">Loading datasets…</p>}
      {datasets.length > 0 && <div className="form-field"><Label htmlFor="dataset-query">Search releases to choose</Label><Input id="dataset-query" type="search" value={datasetQuery} onChange={(event) => setDatasetQuery(event.target.value)} placeholder="Name, publisher, or agency" /></div>}
      {datasets.length > 0 && <p className="muted" role="status">Showing {shownDatasets.length} of {visibleDatasets.length} releases{visibleDatasets.length !== datasets.length ? ` (${datasets.length} in total)` : ''}.</p>}
      <ul className="dataset-list">
        {shownDatasets.map((release) => {
          const id = pickId(release);
          const checked = selectedIds.includes(id);
          const runnable = (release.rowCount ?? 0) > 0;
          return <li key={id}>
            <div className="dataset-pick">
              <input id={`pick-${id}`} type="checkbox" checked={checked} disabled={!runnable || (!checked && selectedIds.length >= 2)} aria-describedby={`pick-note-${id}`} onChange={() => toggleDataset(id)} />
              <Label htmlFor={`pick-${id}`}>{release.name}</Label>
            </div>
            <p className="muted" id={`pick-note-${id}`}>Agency: {agencyName(release.agencyId)} · Region: {release.region || '—'} · Freshness: <strong>{release.freshnessStatus || 'unknown'}</strong> · {licenceLabel(release)} · {runnable ? `${(release.rowCount ?? 0).toLocaleString()} stored rows` : 'no stored rows, so insights cannot run on it'}</p>
          </li>;
        })}
      </ul>
      {!showAllDatasets && visibleDatasets.length > shownDatasets.length && <div className="more"><Button type="button" variant="outline" size="md" onClick={() => setShowAllDatasets(true)}>Show all {visibleDatasets.length} releases</Button></div>}
      {showAllDatasets && visibleDatasets.length > 15 && <div className="more"><Button type="button" variant="outline" size="md" onClick={() => setShowAllDatasets(false)}>Show the first 15 again</Button></div>}
      {selectedReleases.length > 0 && <h3>Columns of the selected releases</h3>}
      {selectedReleases.map((release) => {
        const columns = release.metadata?.schema?.columns ?? [];
        return <div className="selected-columns" key={pickId(release)}>
          <h4>{release.name}</h4>
          {columns.length > 0
            ? <div className="table-scroll" role="region" aria-label={`Stored schema columns of ${release.name}`} tabIndex={0}>
                <table>
                  <caption>Stored schema columns of {release.name}</caption>
                  <thead><tr><th scope="col">Column</th><th scope="col">Type</th></tr></thead>
                  <tbody>{columns.map((column) => <tr key={column.name}><th scope="row">{column.name}</th><td>{column.type || 'text'}</td></tr>)}</tbody>
                </table>
              </div>
            : <p className="muted">no stored schema</p>}
        </div>;
      })}
      </Card>
    </section>
      </>}
      {view === 'analyze' && <>
        <div className="view-head">
          <h1>Analyse</h1>
          <p className="lede">Run a deterministic analysis, see the matching rows before you commit, and keep the result only if you want it reviewed.</p>
        </div>
    <section aria-labelledby="analysis-heading">
      <Card className="card">
      <h2 id="analysis-heading">Run a reproducible analysis</h2>
      <p className="muted">Pick a recipe and filters. The matching row count updates before you run, and every run executes twice so reproducibility is recorded, not assumed.</p>
      <form onSubmit={submit}>
        <div className="form-field"><Label htmlFor="recipe">Recipe</Label><select id="recipe" value={recipe} onChange={(event) => setRecipe(event.target.value)}><option value="summary">Summary</option><option value="compare">Compare</option><option value="rank">Rank</option><option value="distribution">Distribution</option><option value="change_over_time">Change over time</option></select></div>
        {recipe === 'compare' ? <><div className="form-field"><Label htmlFor="compare-year-a">First fiscal year</Label><select id="compare-year-a" value={compareYears[0]} onChange={(event) => setCompareYears([event.target.value, compareYears[1]])}>{(dataset?.coverage.fiscalYears ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</select></div><div className="form-field"><Label htmlFor="compare-year-b">Second fiscal year</Label><select id="compare-year-b" value={compareYears[1]} onChange={(event) => setCompareYears([compareYears[0], event.target.value])}>{(dataset?.coverage.fiscalYears ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</select></div></> : <div className="form-field"><Label htmlFor="fiscal-year">Fiscal year (optional)</Label><Input id="fiscal-year" inputMode="numeric" type="number" min="2000" max="2026" value={year} onChange={(event) => setYear(event.target.value)} placeholder="All years" /></div>}
        <div className="form-field"><Label htmlFor="coverage-status">Coverage status (optional)</Label><select id="coverage-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="published_source_baseline">Published source baseline</option><option value="partial_historical_coverage">Partial historical coverage</option><option value="reenacted_no_new_gaa">Reenacted, no new GAA</option><option value="published_editions_differ">Published editions differ</option></select></div>
        {matchingRows !== undefined && <p className="muted">Matching coverage rows: <strong>{matchingRows}</strong></p>}{previewError && <p role="status" className="muted">{previewError}</p>}
        <Button type="submit" variant="primary" size="md" isLoading={loading} disabled={loading}>{loading ? 'Running…' : 'Run analysis'}</Button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}{validationFailure && <div role="status"><p>Validation: <strong>{validationFailure.status}</strong>{validationFailure.reproducibility_status && <> · Reproducibility: <strong>{validationFailure.reproducibility_status}</strong></>}</p><ul>{validationFailure.checks.map((check) => <li key={check}>{check}</li>)}</ul></div>}
      {analysis && <div className="result" aria-live="polite">{analysis.recipe === 'rank' && isRankResult(analysis.result) && <RankChart rows={analysis.result} />}{analysis.recipe === 'change_over_time' && isTrendResult(analysis.result) && <TrendChart rows={analysis.result} />}{analysis.recipe === 'distribution' && isDistributionResult(analysis.result) && <DistributionChart result={analysis.result} />}{analysis.recipe === 'compare' && isCompareResult(analysis.result) && <CompareChart result={analysis.result} />}<h3>Result</h3><p>Recipe: <strong>{analysis.recipe}</strong> · Reproducibility: <strong>{analysis.reproducibility_status}</strong> · Validation: <strong>{analysis.validation.status}</strong></p><p>{analysis.input_rows} input rows → {analysis.output_rows} output rows</p><p><strong>Calculation:</strong> {analysis.calculation}</p><details><summary>Raw result JSON</summary><pre>{JSON.stringify(analysis.result, null, 2)}</pre></details>{analysis.warnings.length > 0 && <><h4>Warnings</h4><ul>{analysis.warnings.map((item) => <li key={item}>{item}</li>)}</ul></>}{analysis.limitations.map((item) => <p className="muted" key={item}>{item}</p>)}{analysis.evidence_id && <div className="form-field"><Label htmlFor="finding-claim">Claim</Label><textarea id="finding-claim" required minLength={20} maxLength={1000} value={claim} onChange={(event) => setClaim(event.target.value)} placeholder="State what a reviewer should verify about this result." /></div>}{analysis.evidence_id && <Button type="button" variant="outline" size="md" onClick={saveFinding} disabled={loading}>Save as Unverified finding</Button>}{findingError && <p role="alert" className="error">{findingError}</p>}{finding && <p className="muted">Finding <a href={`${apiBase}/api/v1/findings/${finding.id}/page`}>{finding.id}</a> is <strong>{finding.status}</strong> with <strong>{finding.impact}</strong> impact.</p>}</div>}
      </Card>
    </section>
    <section aria-labelledby="insights-heading">
      <Card className="card">
      <h2 id="insights-heading">Run insights</h2>
      <p className="muted">Runs every recipe the selected data supports and lists the rest with the requirement each failed. A run reads the data live and writes no evidence until an analysis is saved.</p>
      {selectedReleases.length > 0 && <ol className="run-selection">
        {selectedReleases.map((release, index) => <li key={pickId(release)}>{index === 0 ? 'Left' : 'Right'}: {release.name}</li>)}
      </ol>}
      {selectedReleases.length === 0 ? <div className="empty">
        <h3>No dataset is selected yet</h3>
        <p>This view runs every recipe the chosen data supports. Choose one release, or two to join, and come back.</p>
        <a className="cta" href="#/datasets">Choose datasets</a>
      </div> : <form onSubmit={submitRun}>
        {selectedReleases.length === 2 && <>
          <div className="form-field"><Label htmlFor="run-left-key">Join key from the left release ({selectedReleases[0].name})</Label><select id="run-left-key" value={leftKey} onChange={(event) => setLeftKey(event.target.value)}><option value="">Choose a column</option>{releaseColumns(selectedReleases[0]).map((column) => <option key={column.name} value={column.name}>{column.name} ({column.type ?? 'unknown type'})</option>)}</select></div>
          <div className="form-field"><Label htmlFor="run-right-key">Join key from the right release ({selectedReleases[1].name})</Label><select id="run-right-key" value={rightKey} onChange={(event) => setRightKey(event.target.value)}><option value="">Choose a column</option>{releaseColumns(selectedReleases[1]).map((column) => <option key={column.name} value={column.name}>{column.name} ({column.type ?? 'unknown type'})</option>)}</select></div>
        </>}
        <div className="form-field"><Label htmlFor="run-period-a">First period for compare (optional)</Label><Input id="run-period-a" value={periodA} onChange={(event) => setPeriodA(event.target.value)} placeholder="e.g. 2024" /></div>
        <div className="form-field"><Label htmlFor="run-period-b">Second period for compare (optional)</Label><Input id="run-period-b" value={periodB} onChange={(event) => setPeriodB(event.target.value)} placeholder="e.g. 2025" /></div>
        <Button type="submit" variant="primary" size="md" isLoading={running} disabled={running || !canRun}>{running ? 'Running…' : 'Run insights'}</Button>
      </form>}
      {running && <p role="status">Running insights…</p>}
      {datasets.length > 0 && !canRun && !running && selectedReleases.length > 0 && <p className="muted">{selectedReleases.some((release) => releaseColumns(release).length === 0)
        ? 'A selected release exposes no columns, so its join keys cannot be chosen.'
        : 'Choose a join key from each side to enable the run.'}</p>}
      {runError && <p role="alert" className="error">{runError}</p>}
      {runResult && <p role="status" className="run-summary">{runResult.summary}</p>}
      {runResult && <>
        <h3>Insights</h3>
        <div className="insight-list">
          {runResult.insights.map((insight) => <article className="insight-card" key={insight.id}>
            <h4>{recipeLabel(insight.recipe)}</h4>
            <p>Status: <strong>{insight.status}</strong></p>
            {insight.status === 'skipped'
              ? <p><strong>Skipped:</strong> {insight.reason || 'no reason reported.'}</p>
              : <>
                  <p><strong>Calculation:</strong> {insight.calculation || '—'}</p>
                  {insight.warnings && insight.warnings.length > 0 && <ul>{insight.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                  {renderInsightResult(insight.recipe, insight.result)}
                </>}
          </article>)}
        </div>
        <div className="next-steps">
          <h3>Next steps</h3>
          {runEvidenceId
            ? <>
                <div className="form-field"><Label htmlFor="run-claim">Claim</Label><textarea id="run-claim" required minLength={20} maxLength={1000} value={runClaim} onChange={(event) => setRunClaim(event.target.value)} placeholder="State what a reviewer should verify about this result." /></div>
                <Button type="button" variant="outline" size="md" onClick={saveRunFinding} disabled={savingRun}>Save as unverified finding</Button>
              </>
            : <p className="muted">This run is read-only: it answers what the data says, and writes no evidence. To submit a finding, run a reproducible analysis, which records evidence you can attach a claim to. <a href="#/analyze">Go to reproducible analysis</a></p>}
          {saveStatus && <p role="status" className="muted">{saveStatus}</p>}
          {saveError && <p role="alert" className="error">{saveError}</p>}
          <p><a href={`${apiBase}/api/v1/runs/${runResult.run_id}`}>View this run's public JSON</a></p>
        </div>
      </>}
      </Card>
    </section>
    <section aria-labelledby="join-heading">
      <Card className="card">
      <h2 id="join-heading">Curated join</h2>
      <p>Joins the validated BetterGov GAA coverage release with a clearly labeled <strong>synthetic fixture</strong> on the explicit <code>fiscal_year</code> key. The fixture is test data, not a real government dataset, and no other dataset pair can be joined here. Diagnostics show unmatched rows and duplicate keys instead of hiding them.</p>
      <Button type="button" variant="primary" size="md" onClick={runCuratedJoin} isLoading={joining} disabled={joining}>{joining ? 'Joining…' : 'Run curated join'}</Button>
      {joinedStatus && <p role="status" className="muted">{joinedStatus}</p>}
      {joinedError && <p role="alert" className="error">{joinedError}</p>}
      {joined && <div className="join-result">
        <h3>Join diagnostics</h3>
        <dl className="diagnostics">
          <div><dt>Matched rows</dt><dd>{joined.matched_rows ?? 0}</dd></div>
          <div><dt>Unmatched left rows</dt><dd>{joined.unmatched_left ?? 0}</dd></div>
          <div><dt>Unmatched right rows</dt><dd>{joined.unmatched_right ?? 0}</dd></div>
          <div><dt>Duplicate right keys</dt><dd>{joined.duplicate_right_keys ?? 0}</dd></div>
          <div><dt>Input rows, left</dt><dd>{joined.input_left_rows ?? 0}</dd></div>
          <div><dt>Input rows, right</dt><dd>{joined.input_right_rows ?? 0}</dd></div>
          <div><dt>Reproducibility</dt><dd>{joined.reproducibility_status ?? 'Not run'}</dd></div>
          <div><dt>Validation</dt><dd>{joined.validation?.status ?? 'Not run'}</dd></div>
          <div><dt>Relationship</dt><dd><code>{joined.relationship_id ?? 'unknown'}</code></dd></div>
        </dl>
        {joined.validation?.checks && joined.validation.checks.length > 0 && <ul>{joined.validation.checks.map((check) => <li key={check}>{check}</li>)}</ul>}
        {joined.warnings && joined.warnings.length > 0 && <><h4>Warnings</h4><ul>{joined.warnings.map((item) => <li key={item}>{item}</li>)}</ul></>}
        {joined.limitations?.map((item) => <p className="muted" key={item}>{item}</p>)}
        <p className="muted">This is a joined analysis candidate; it has not been human-reviewed.</p>
        {joined.evidence_id ? <p><a href={`${apiBase}/api/v1/evidence/${encodeURIComponent(joined.evidence_id)}`}>View joined evidence JSON</a> · Evidence: <code>{joined.evidence_id}</code></p> : <p className="muted">No evidence record was returned.</p>}
        {joined.finding_id && <p><a href={`${apiBase}/api/v1/findings/${encodeURIComponent(joined.finding_id)}/page`}>View finding page</a></p>}
      </div>}
      </Card>
    </section>
      </>}
      {view === 'review' && <>
        <div className="view-head">
          <h1>{reviewer ? 'Review' : 'Your work'}</h1>
          <p className="lede">{reviewer
            ? 'Decide what happens to a finding, read the evidence behind it, and record why. Your decision and its reason stay in the history.'
            : 'Saved views, dataset drafts, and the findings you have submitted.'}</p>
        </div>
        {!user && <div className="empty">
          <h2>Sign in to keep work here</h2>
          <p>Browsing, filtering, and analysis are anonymous. An account is only needed to submit a finding, comment, review, or upload a dataset.</p>
        </div>}
    {reviewer && <section aria-labelledby="queue-heading">
      <Card className="card">
      <h2 id="queue-heading">Review queue</h2>
      <div className="filter-row">
        <div className="form-field"><Label htmlFor="queue-filter-status">Status</Label><select id="queue-filter-status" value={queueFilterStatus} onChange={(event) => setQueueFilterStatus(event.target.value)}><option value="">All statuses</option><option value="Pending verification">Pending verification</option><option value="In review">In review</option></select></div>
        <div className="form-field"><Label htmlFor="queue-filter-impact">Impact</Label><select id="queue-filter-impact" value={queueFilterImpact} onChange={(event) => setQueueFilterImpact(event.target.value)}><option value="">All impacts</option><option value="low">Low</option><option value="standard">Standard</option><option value="high">High</option></select></div>
        <div className="form-field"><Label htmlFor="queue-filter-query">Search claims</Label><Input id="queue-filter-query" type="search" value={queueFilterQuery} onChange={(event) => setQueueFilterQuery(event.target.value)} placeholder="Text in the claim" /></div>
      </div>
      <div className="pagination">
        <div className="form-field"><Label htmlFor="queue-limit">Findings per page</Label><select id="queue-limit" value={queueLimit} onChange={(event) => setQueueLimit(event.target.value)}><option value="">Default</option><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></div>
        <div className="form-field"><Label htmlFor="queue-offset">Queue offset</Label><Input id="queue-offset" type="number" min="0" inputMode="numeric" placeholder="0" value={queueOffset} onChange={(event) => setQueueOffset(event.target.value)} /></div>
      </div>
      <p role="status" className="muted">{queueReady ? `${queue.length} finding${queue.length === 1 ? '' : 's'} showing${queueLimit ? ` · ${queueLimit} per page` : ''}${queueOffset && queueOffset !== '0' ? ` · from ${queueOffset}` : ''}` : 'Loading review queue…'}</p>
      {queueError && <p role="alert" className="error">{queueError}</p>}
      {reviewStatus && <p role="status" className="muted">{reviewStatus}</p>}
      {!queueReady ? null : queue.length === 0 ? <p>No findings are waiting for review.</p> : <ul className="queue-list">{queue.map((item) => {
        const draft = decisionDrafts[item.id] ?? { status: '', reason: '' };
        const allowed = nextStatuses[item.status] ?? [];
        return <li key={item.id}>
          {/* A reviewer decides from this line, so the claim leads and the id is reference. */}
          <p className="queue-claim">{item.claim || 'No claim was recorded for this finding.'}</p>
          <p className="queue-meta"><span className={`pill pill-${statusSlug(item.status)}`}>{item.status}</span> · {item.impact} impact · <code>{item.id}</code></p>
          <Button type="button" variant="outline" size="md" onClick={() => loadFinding(item.id)}>View finding and evidence</Button>
          {allowed.length > 0 ? <details className="decision"><summary>Record a decision</summary>
          <form className="review-form" onSubmit={(event) => decide(event, item)}>
            <div className="form-field"><Label htmlFor={`decision-status-${item.id}`}>Decision status</Label><select id={`decision-status-${item.id}`} required value={draft.status} onChange={(event) => setDecisionDrafts((current) => ({ ...current, [item.id]: { ...draft, status: event.target.value } }))}><option value="">Choose a status</option>{allowed.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
            <div className="form-field"><Label htmlFor={`decision-reason-${item.id}`}>Reason for this decision</Label><textarea id={`decision-reason-${item.id}`} required maxLength={2000} value={draft.reason} onChange={(event) => setDecisionDrafts((current) => ({ ...current, [item.id]: { ...draft, reason: event.target.value } }))} /></div>
            <Button type="submit" variant="primary" size="md">Submit decision</Button>
          </form>
          </details> : <p className="muted">No further decision is available.</p>}
        </li>;
      })}</ul>}
      </Card>
    </section>}
    {(selected || detailLoading || detailError) && <section aria-labelledby="finding-heading">
      <Card className="card">
      <h2 id="finding-heading">Finding detail</h2>
      {detailLoading && <p role="status">Loading finding…</p>}
      {detailError && <p role="alert" className="error">{detailError}</p>}
      {selected && <>
        <p>Status: <strong>{selected.status}</strong> · Impact: <strong>{selected.impact}</strong></p>
        {selected.claim && <p><strong>Claim:</strong> {selected.claim}</p>}
        <h3>Explanation</h3>
        {explanation ? <>
          <p className="explanation-text">{explanation.text}</p>
          <p className="muted">Source: {explanation.source === 'llm' ? 'LLM' : 'template'}{explanation.provider ? ` · Provider: ${explanation.provider}` : ''}{explanation.model ? ` · Model: ${explanation.model}` : ''} · Template version: {explanation.templateVersion}</p>
        </> : <p>No explanation generated yet.</p>}
        {user && <div className="explanation-actions"><Button type="button" variant="outline" size="sm" onClick={generateExplanation}>Generate explanation</Button></div>}
        <h3>Decision history</h3>
        {history.length === 0 ? <p>No decisions recorded yet.</p> : <ol>{history.map((transition, index) => <li key={`${transition.createdAt}-${index}`}><strong>{transition.toStatus}</strong>{transition.fromStatus ? <> from {transition.fromStatus}</> : null} — {transition.reason} <span className="muted">({transition.createdAt})</span></li>)}</ol>}
        <h3>Comments</h3>
        {comments.length === 0 ? <p>No comments yet.</p> : <ol className="comment-list">{comments.map((comment) => <li key={comment.id}>
          {comment.status === 'removed' ? <p><strong>Comment removed by a moderator</strong>{comment.removalReason ? ` — ${comment.removalReason}` : ''}</p> : <p>{comment.body} <span className="muted">({comment.createdAt})</span></p>}
          {reviewer && comment.status === 'visible' && <form className="removal-form" onSubmit={(event) => removeComment(event, comment)}>
            <div className="form-field"><Label htmlFor={`removal-reason-${comment.id}`}>Reason for removing this comment</Label><Input id={`removal-reason-${comment.id}`} required maxLength={500} value={removalReasons[comment.id] ?? ''} onChange={(event) => setRemovalReasons((current) => ({ ...current, [comment.id]: event.target.value }))} /></div>
            <Button type="submit" variant="outline" size="md">Remove comment</Button>
          </form>}
        </li>)}</ol>}
        {user && <form onSubmit={submitComment}>
          <div className="form-field"><Label htmlFor="comment-body">Add a comment</Label><textarea id="comment-body" required maxLength={5000} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} /></div>
          <Button type="submit" variant="primary" size="md">Post comment</Button>
        </form>}
      </>}
      </Card>
    </section>}
    {user && <section aria-labelledby="views-heading">
      <Card className="card">
      <h2 id="views-heading">Saved views</h2>
      <p className="muted">Save the current recipe, fiscal year, coverage status, and comparison as a named view, or restore a saved one.</p>
      <form onSubmit={saveView}>
        <div className="form-field"><Label htmlFor="view-name">View name</Label><Input id="view-name" required maxLength={120} value={viewName} onChange={(event) => setViewName(event.target.value)} /></div>
        <Button type="submit" variant="primary" size="md">Save current filters</Button>
      </form>
      <div className="pagination">
        <div className="form-field"><Label htmlFor="views-limit">Saved views per page</Label><select id="views-limit" value={viewsLimit} onChange={(event) => setViewsLimit(event.target.value)}><option value="">Default</option><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></div>
        <div className="form-field"><Label htmlFor="views-offset">Saved views offset</Label><Input id="views-offset" type="number" min="0" inputMode="numeric" placeholder="0" value={viewsOffset} onChange={(event) => setViewsOffset(event.target.value)} /></div>
      </div>
      {viewsStatus && <p role="status" className="muted">{viewsStatus}</p>}
      {viewsError && <p role="alert" className="error">{viewsError}</p>}
      {savedViews.length === 0 ? <p>No saved views yet.</p> : <ul className="view-list">{savedViews.map((view) => <li key={view.id}>
        <Button type="button" variant="outline" size="md" onClick={() => restoreView(view)}>Restore {view.name}</Button>
        <p className="muted">{describeFilters(view.filters)} · saved {new Date(view.createdAt).toLocaleDateString()}</p>
      </li>)}</ul>}
      </Card>
    </section>}
    {user && <section aria-labelledby="upload-heading">
      <Card className="card">
      <h2 id="upload-heading">Upload a dataset draft</h2>
      <p className="muted">CSV, JSON, XLSX, or Parquet. Every upload stays a private draft until a maintainer publishes it.</p>
      <form onSubmit={registerUpload}>
        <div className="form-field"><Label htmlFor="upload-file">Data file</Label><input id="upload-file" type="file" accept=".csv,.json,.xlsx,.parquet" required onChange={(event) => setUploadFile(event.target.files?.[0])} /></div>
        <div className="form-field"><Label htmlFor="upload-name">Draft name</Label><Input id="upload-name" required maxLength={120} value={uploadName} onChange={(event) => setUploadName(event.target.value)} /></div>
        <Button type="submit" variant="primary" size="md" disabled={!uploadFile}>Register draft</Button>
      </form>
      {uploadStatus && <p role="status" className="muted">{uploadStatus}</p>}
      {uploadError && <p role="alert" className="error">{uploadError}</p>}
      {uploadDraft && <div className="import-result">
        <h3>Draft <code>{uploadDraft.id}</code></h3>
        <p>Status: <strong>{uploadDraft.status}</strong> · Rows: <strong>{uploadDraft.validation?.rows ?? 0}</strong></p>
        {uploadDraft.validation?.status && <p>Validation: <strong>{uploadDraft.validation.status}</strong></p>}
        {uploadDraft.checkRows && <p>Row check: <strong>{uploadDraft.checkRows}</strong></p>}
        {uploadDraft.validation?.checks && uploadDraft.validation.checks.length > 0 && <ul>{uploadDraft.validation.checks.map((check) => <li key={check}>{check}</li>)}</ul>}
        {uploadDraft.status === 'quarantined' && <p role="alert" className="error">Quarantined ({uploadDraft.checkRows ?? 'schema_invalid'}): this draft is not published and cannot be published until it is corrected and re-uploaded.</p>}
      </div>}
      {maintainer && uploadDraft?.status === 'validated' && <form className="publish-form" onSubmit={(event) => publishDraft(event, uploadDraft)}>
        <h3>Publish this validated draft</h3>
        <div className="form-field"><Label htmlFor="publish-reason">Reason for publishing</Label><textarea id="publish-reason" required maxLength={2000} value={publishForm.reason} onChange={(event) => setPublishForm({ ...publishForm, reason: event.target.value })} /></div>
        <div className="form-field"><Label htmlFor="publish-publisher">Publisher</Label><Input id="publish-publisher" required maxLength={200} value={publishForm.publisher} onChange={(event) => setPublishForm({ ...publishForm, publisher: event.target.value })} /></div>
        <div className="form-field"><Label htmlFor="publish-source-url">Source URL</Label><Input id="publish-source-url" type="url" required value={publishForm.sourceUrl} onChange={(event) => setPublishForm({ ...publishForm, sourceUrl: event.target.value })} /></div>
        <div className="form-field"><Label htmlFor="publish-license">License</Label><Input id="publish-license" required maxLength={200} value={publishForm.license} onChange={(event) => setPublishForm({ ...publishForm, license: event.target.value })} /></div>
        <div className="form-field"><Label htmlFor="publish-fiscal-years">Fiscal years (comma separated)</Label><Input id="publish-fiscal-years" required placeholder="2024, 2025" value={publishForm.fiscalYears} onChange={(event) => setPublishForm({ ...publishForm, fiscalYears: event.target.value })} /></div>
        <div className="form-field"><Label htmlFor="publish-fields">Field definitions, one per line as name:type:description</Label><textarea id="publish-fields" required placeholder="amount:number:Amount in pesos" value={publishForm.fields} onChange={(event) => setPublishForm({ ...publishForm, fields: event.target.value })} /></div>
        <div className="form-field"><Label htmlFor="publish-limitations">Limitations, one per line</Label><textarea id="publish-limitations" value={publishForm.limitations} onChange={(event) => setPublishForm({ ...publishForm, limitations: event.target.value })} /></div>
        <Button type="submit" variant="primary" size="md" isLoading={publishing} disabled={publishing}>{publishing ? 'Publishing…' : 'Publish draft'}</Button>
        {publishStatus && <p role="status" className="muted">{publishStatus}</p>}
        {publishError && <p role="alert" className="error">{publishError}</p>}
      </form>}
      </Card>
    </section>}
      </>}
    </main>
    <footer className="footer">
      <p>SaySight turns public datasets into checkable public findings. Every number here is reproducible from a cited release, and no figure is written by a model.</p>
      <p className="muted"><a href="#/findings">Findings</a> · <a href="#/datasets">Datasets</a> · <a href="#/analyze">Analyse</a></p>
    </footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
