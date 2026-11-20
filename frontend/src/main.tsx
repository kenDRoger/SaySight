import { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@bettergov/kapwa/button';
import { Card } from '@bettergov/kapwa/card';
import { Input } from '@bettergov/kapwa/input';
import { Label } from '@bettergov/kapwa/label';
import './styles.css';

type Dataset = {
  name: string;
  publisher: string;
  sourceUrl: string;
  releaseId: string;
  checksum: string;
  coverage: { fiscalYears: number[] };
  fields: Array<{ name: string; type: string; unit?: string; description: string }>;
  reuseTerms: string;
  limitations: string[];
};

type Analysis = { recipe: string; calculation: string; input_rows: number; output_rows: number; result: unknown; validation: { status: string; checks: string[] }; warnings: string[]; limitations: string[]; reproducibility_status: string; evidence_id?: string };
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
const failureMessage = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
const failureStatus = (reason: unknown) => reason instanceof Error && 'status' in reason ? Number((reason as ApiFailure).status) : 0;

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
  const reviewer = isReviewer(user?.role);

  useEffect(() => {
    fetch(`${apiBase}/api/v1/datasets`).then((response) => response.json()).then((body) => setDataset(body.datasets[0])).catch(() => setError('The catalog is currently unavailable.'));
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
    apiRequest<{ findings: Finding[] }>('/api/v1/review/queue')
      .then((body) => { if (active) setQueue(body.findings); })
      .catch((reason: unknown) => { if (active) setQueueError(failureMessage(reason, 'Review queue unavailable.')); })
      .finally(() => { if (active) setQueueReady(true); });
    return () => { active = false; };
  }, [reviewer]);

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
        const refreshed = await apiRequest<{ findings: Finding[] }>('/api/v1/review/queue');
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
      <p className="eyebrow">Public data, checked together</p><h1>SaySight</h1><p className="lede">Explore public datasets and build findings with visible sources, calculations, and limitations.</p>
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
      </> : <p>Loading catalog…</p>}
      </Card>
    </section>
    <section aria-labelledby="analysis-heading">
      <Card className="card">
      <h2 id="analysis-heading">Run a reproducible analysis</h2>
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
    {reviewer && <section aria-labelledby="queue-heading">
      <Card className="card">
      <h2 id="queue-heading">Review queue</h2>
      {queueError && <p role="alert" className="error">{queueError}</p>}
      {reviewStatus && <p role="status" className="muted">{reviewStatus}</p>}
      {!queueReady ? <p role="status">Loading review queue…</p> : queue.length === 0 ? <p>No findings are waiting for review.</p> : <ul className="queue-list">{queue.map((item) => {
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
