import { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@bettergov/kapwa/button';
import { Card } from '@bettergov/kapwa/card';
import { Input } from '@bettergov/kapwa/input';
import { Label } from '@bettergov/kapwa/label';
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
};

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
type Finding = { id: string; status: string; impact: string };
type Transition = { fromStatus: string; toStatus: string; reason: string; createdAt: string };
type FindingComment = { id: string; body: string; status: 'visible' | 'removed'; removalReason: string | null; createdAt: string };
type Explanation = { id: string; text: string; source: 'llm' | 'template'; provider: string | null; model: string | null; templateVersion: string };
type ApiFailure = Error & { status: number };

const apiBase = import.meta.env.VITE_API_URL ?? '';

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

// Pagination is opt-in: an untouched control sends no query parameter, so the
// API default response shape is preserved.
const pageQuery = (limit: string, offset: string) => {
  const params = new URLSearchParams();
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
  const [user, setUser] = useState<User>();
  const [sessionReady, setSessionReady] = useState(false);
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
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState('');
  const [viewsStatus, setViewsStatus] = useState('');
  const [viewsError, setViewsError] = useState('');
  const [viewsLimit, setViewsLimit] = useState('');
  const [viewsOffset, setViewsOffset] = useState('');
  const [queueLimit, setQueueLimit] = useState('');
  const [queueOffset, setQueueOffset] = useState('');
  const [uploadFile, setUploadFile] = useState<File>();
  const [uploadName, setUploadName] = useState('');
  const [uploadDraft, setUploadDraft] = useState<ImportDraft>();
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [publishForm, setPublishForm] = useState({ reason: '', publisher: '', sourceUrl: '', license: '', fiscalYears: '', fields: '', limitations: '' });
  const [publishStatus, setPublishStatus] = useState('');
  const [publishError, setPublishError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const reviewer = isReviewer(user?.role);
  const maintainer = user?.role === 'maintainer';
  const agencyName = (id: string | null | undefined) => agencies.find((item) => item.id === id)?.name ?? id ?? 'Unlisted agency';

  useEffect(() => {
    fetch(`${apiBase}/api/v1/datasets`).then((response) => response.json()).then((body) => {
      const list = body.datasets ?? [];
      setReleases(list);
      // The catalog is alphabetical, which would put a test fixture first. Feature the
      // verified release when it is present and keep the full list below it.
      setDataset(list.find((item: Dataset) => item.publisher === 'BetterGovPH') ?? list[0]);
    }).catch(() => setError('The catalog is currently unavailable.'));
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
    fetch(`${apiBase}/api/v1/datasets/bettergov-gaa-coverage-2026-11-07/preview${query}`).then((response) => { if (!response.ok) throw new Error('Preview unavailable'); return response.json(); }).then((body) => { setMatchingRows(body.matching_rows); setPreviewError(''); }).catch(() => { setMatchingRows(undefined); setPreviewError('Matching-row preview is unavailable.'); });
  }, [year, status, recipe, compareYears]);

  useEffect(() => {
    apiRequest<{ user: User }>('/api/v1/auth/me')
      .then((body) => setUser(body.user))
      .catch((reason: unknown) => { if (failureStatus(reason) !== 401) setSessionError(failureMessage(reason, 'Account service unavailable.')); })
      .finally(() => setSessionReady(true));
  }, []);

  useEffect(() => {
    if (!reviewer) return;
    let active = true;
    setQueueReady(false); setQueueError('');
    apiRequest<{ findings: Finding[] }>(`/api/v1/review/queue${pageQuery(queueLimit, queueOffset)}`)
      .then((body) => { if (active) setQueue(body.findings); })
      .catch((reason: unknown) => { if (active) setQueueError(failureMessage(reason, 'Review queue unavailable.')); })
      .finally(() => { if (active) setQueueReady(true); });
    return () => { active = false; };
  }, [reviewer, queueLimit, queueOffset]);

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
      const created = await apiRequest<Finding>('/api/v1/findings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ evidence_id: analysis.evidence_id }) });
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
        const refreshed = await apiRequest<{ findings: Finding[] }>(`/api/v1/review/queue${pageQuery(queueLimit, queueOffset)}`);
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
      setUploadDraft({ ...draft, status: 'published' });
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

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(''); setAnalysis(undefined); setValidationFailure(undefined);
    try {
      const response = await fetch(`${apiBase}/api/v1/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipe, ...(recipe === 'compare' ? { compare_years: compareYears.map(Number) } : year ? { year: Number(year) } : {}), ...(status ? { status } : {}) }) });
      const body = await response.json();
      if (!response.ok) { if (body.validation) setValidationFailure({ ...body.validation, reproducibility_status: body.reproducibility_status }); throw new Error(body.error ?? 'Analysis failed.'); }
      setAnalysis(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Analysis failed.'); }
    finally { setLoading(false); }
  }

  return <main>
    <header>
      <h1>SaySight</h1><p className="lede">Turn public datasets into checkable findings: every result shows its source, calculation, validation, and limitations.</p>
      <nav className="guide" aria-label="What you can do here">
        <h2 className="guide-title">What you can do here</h2>
        <ol>
          <li><a href="#dataset-heading">Explore</a> a cataloged release and its field definitions.</li>
          <li><a href="#analysis-heading">Run</a> one of five deterministic recipes and see the matching rows first.</li>
          <li><a href="#join-heading">Compare</a> two releases with the curated join and its diagnostics.</li>
        </ol>
        <p className="muted">Browsing, filtering, and analysis are anonymous. Sign in to save findings, comment, review, or upload.</p>
      </nav>
      <div className="session">
        {!sessionReady ? <p role="status">Checking account…</p> : user ? <>
          <p role="status">Signed in as <strong>{user.email}</strong> ({user.role}).</p>
          <Button type="button" variant="outline" size="md" onClick={signOut}>Sign out</Button>
        </> : <>
          <form onSubmit={requestLink}>
            <div className="form-field"><Label htmlFor="sign-in-email">Email for a sign-in link</Label><Input id="sign-in-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
            <Button type="submit" variant="primary" size="md" isLoading={requestingLink} disabled={requestingLink}>{requestingLink ? 'Sending…' : 'Send sign-in link'}</Button>
          </form>
          {sessionMessage && <p role="status" className="muted">{sessionMessage}</p>}
        </>}
        {sessionError && <p role="alert" className="error">{sessionError}</p>}
      </div>
    </header>
    <section aria-labelledby="dataset-heading">
      <Card className="card">
      <h2 id="dataset-heading">Dataset catalog</h2>
      <p className="muted">One verified release is the working dataset. Other entries are published releases and test fixtures; each lists its agency, region, and freshness so you can judge it before using it.</p>
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
      {analysis && <div className="result" aria-live="polite"><h3>Result</h3><p>Recipe: <strong>{analysis.recipe}</strong> · Reproducibility: <strong>{analysis.reproducibility_status}</strong> · Validation: <strong>{analysis.validation.status}</strong></p><p>{analysis.input_rows} input rows → {analysis.output_rows} output rows</p><p><strong>Calculation:</strong> {analysis.calculation}</p><pre>{JSON.stringify(analysis.result, null, 2)}</pre>{analysis.warnings.length > 0 && <><h4>Warnings</h4><ul>{analysis.warnings.map((item) => <li key={item}>{item}</li>)}</ul></>}{analysis.limitations.map((item) => <p className="muted" key={item}>{item}</p>)}{analysis.evidence_id && <Button type="button" variant="outline" size="md" onClick={saveFinding} disabled={loading}>Save as Unverified finding</Button>}{findingError && <p role="alert" className="error">{findingError}</p>}{finding && <p className="muted">Finding <a href={`${apiBase}/api/v1/findings/${finding.id}/page`}>{finding.id}</a> is <strong>{finding.status}</strong> with <strong>{finding.impact}</strong> impact.</p>}</div>}
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
    {reviewer && <section aria-labelledby="queue-heading">
      <Card className="card">
      <h2 id="queue-heading">Review queue</h2>
      <div className="pagination">
        <div className="form-field"><Label htmlFor="queue-limit">Findings per page</Label><select id="queue-limit" value={queueLimit} onChange={(event) => setQueueLimit(event.target.value)}><option value="">Default</option><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></div>
        <div className="form-field"><Label htmlFor="queue-offset">Queue offset</Label><Input id="queue-offset" type="number" min="0" inputMode="numeric" placeholder="0" value={queueOffset} onChange={(event) => setQueueOffset(event.target.value)} /></div>
      </div>
      <p role="status" className="muted">{queueReady ? `${queue.length} finding${queue.length === 1 ? '' : 's'} shown${queueLimit ? ` · limit ${queueLimit}` : ' · unpaginated'}${queueOffset ? ` · offset ${queueOffset}` : ''}` : 'Loading review queue…'}</p>
      {queueError && <p role="alert" className="error">{queueError}</p>}
      {reviewStatus && <p role="status" className="muted">{reviewStatus}</p>}
      {!queueReady ? null : queue.length === 0 ? <p>No findings are waiting for review.</p> : <ul className="queue-list">{queue.map((item) => {
        const draft = decisionDrafts[item.id] ?? { status: '', reason: '' };
        const allowed = nextStatuses[item.status] ?? [];
        return <li key={item.id}>
          <h3>Finding <code>{item.id}</code></h3>
          <p>Status: <strong>{item.status}</strong> · Impact: <strong>{item.impact}</strong></p>
          <Button type="button" variant="outline" size="md" onClick={() => loadFinding(item.id)}>View finding</Button>
          {allowed.length > 0 ? <form className="review-form" onSubmit={(event) => decide(event, item)}>
            <div className="form-field"><Label htmlFor={`decision-status-${item.id}`}>Decision status</Label><select id={`decision-status-${item.id}`} required value={draft.status} onChange={(event) => setDecisionDrafts((current) => ({ ...current, [item.id]: { ...draft, status: event.target.value } }))}><option value="">Choose a status</option>{allowed.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
            <div className="form-field"><Label htmlFor={`decision-reason-${item.id}`}>Reason for this decision</Label><textarea id={`decision-reason-${item.id}`} required maxLength={2000} value={draft.reason} onChange={(event) => setDecisionDrafts((current) => ({ ...current, [item.id]: { ...draft, reason: event.target.value } }))} /></div>
            <Button type="submit" variant="primary" size="md">Submit decision</Button>
          </form> : <p className="muted">No further decision is available.</p>}
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
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
