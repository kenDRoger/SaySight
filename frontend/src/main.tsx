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

const apiBase = import.meta.env.VITE_API_URL ?? '';

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
  const [finding, setFinding] = useState<{ id: string; status: string }>();

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
    <header><p className="eyebrow">Public data, checked together</p><h1>SaySight</h1><p className="lede">Explore public datasets and build findings with visible sources, calculations, and limitations.</p></header>
    <section aria-labelledby="dataset-heading">
      <Card className="card">
      <h2 id="dataset-heading">Dataset catalog</h2>
      {dataset ? <><h3>{dataset.name}</h3><p>Publisher: {dataset.publisher} · Terms: {dataset.reuseTerms}</p><p><a href={dataset.sourceUrl}>View source metadata</a> · Release: <code>{dataset.releaseId}</code></p><p className="muted">Checksum: <code>{dataset.checksum}</code></p><ul>{dataset.limitations.map((item) => <li key={item}>{item}</li>)}</ul></> : <p>Loading catalog…</p>}
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
      {analysis && <div className="result" aria-live="polite"><h3>Result</h3><p>Recipe: <strong>{analysis.recipe}</strong> · Reproducibility: <strong>{analysis.reproducibility_status}</strong> · Validation: <strong>{analysis.validation.status}</strong></p><p>{analysis.input_rows} input rows → {analysis.output_rows} output rows</p><p><strong>Calculation:</strong> {analysis.calculation}</p><pre>{JSON.stringify(analysis.result, null, 2)}</pre>{analysis.warnings.length > 0 && <><h4>Warnings</h4><ul>{analysis.warnings.map((item) => <li key={item}>{item}</li>)}</ul></>}{analysis.limitations.map((item) => <p className="muted" key={item}>{item}</p>)}{analysis.evidence_id && <Button type="button" variant="outline" size="md" onClick={async () => { const response = await fetch(`${apiBase}/api/v1/findings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ evidence_id: analysis.evidence_id }) }); if (response.ok) setFinding(await response.json()); }}>Save as Unverified finding</Button>}{finding && <p className="muted">Finding <a href={`${apiBase}/api/v1/findings/${finding.id}/page`}>{finding.id}</a> is {finding.status}.</p>}</div>}
      </Card>
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
