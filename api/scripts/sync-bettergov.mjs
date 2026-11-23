// Pins every dataset the BetterGov portal publishes, so the catalog is the portal's catalog
// rather than a hand-picked subset. Each release keeps the portal's own name, licence and
// attribution, and the pin route infers its schema from the bytes.
//
// Run with the stack up: node api/scripts/sync-bettergov.mjs
const api = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3000';
const portal = process.env.BETTERGOV_URL ?? 'https://data.bettergov.ph';
const email = process.env.SAYSIGHT_MAINTAINER_EMAIL ?? 'maintainer@example.org';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function session() {
  const requested = await fetch(`${api}/api/v1/auth/demo-session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'maintainer' }),
  });
  if (requested.ok) return (requested.headers.get('set-cookie') ?? '').split(';')[0];
  // Demo mode off: fall back to the magic link the API logs.
  const { execFileSync } = await import('node:child_process');
  for (let round = 0; round < 6; round += 1) {
    await fetch(`${api}/api/v1/auth/magic-link`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const logs = execFileSync('docker', ['compose', 'logs', 'api', '--since', '2m'], { encoding: 'utf8', timeout: 5000 });
      const marker = `magic link for ${email}: `;
      const line = logs.split('\n').reverse().find((entry) => entry.includes(marker));
      if (line) {
        const link = line.slice(line.indexOf(marker) + marker.length).trim();
        const verified = await fetch(link.replace(/^https?:\/\/[^/]+\/api/, `${api}/api`), { headers: { accept: 'application/json' }, redirect: 'manual' });
        const cookie = verified.headers.get('set-cookie');
        if (cookie) return cookie.split(';')[0];
      }
      await sleep(300);
    }
    await sleep(8000);
  }
  throw new Error('could not obtain a maintainer session');
}

const listPortalDatasets = async () => {
  const response = await fetch(`${portal}/api/v1/datasets`);
  if (!response.ok) throw new Error(`portal listing failed: ${response.status}`);
  const payload = await response.json();
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .filter((item) => item && (typeof item.id === 'number' || typeof item.id === 'string') && typeof item.name === 'string')
    .map((item) => ({
      id: String(item.id), name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
      licence: typeof item.licence === 'string' ? item.licence : (typeof item.license === 'string' ? item.license : undefined),
      updatedAt: typeof item.latest_version_date === 'string' ? item.latest_version_date : undefined,
      attribution: (Array.isArray(item.attribution) && item.attribution[0] && typeof item.attribution[0].attribution_text === 'string')
        ? item.attribution[0].attribution_text : 'BetterGovPH',
    }));
};

// A portal resource is only pinnable if it is tabular and small enough for the API to
// buffer; asking first avoids an out-of-memory kill that would take the whole sync down.
const supportedFormats = ['.csv', '.json', '.xlsx', '.parquet'];
const resourcePlan = async (datasetId) => {
  const response = await fetch(`${portal}/api/v1/resources?dataset_id=${encodeURIComponent(datasetId)}`);
  if (!response.ok) return { pinnable: false, reason: `resource listing HTTP ${response.status}` };
  const payload = await response.json().catch(() => ({}));
  const resources = Array.isArray(payload?.data) ? payload.data : [];
  const candidates = resources.flatMap((entry) => {
    const url = typeof entry?.download_url === 'string' ? entry.download_url : typeof entry?.url === 'string' ? entry.url : undefined;
    if (!url) return [];
    const name = String(entry?.name ?? url.split('/').pop() ?? '').toLowerCase();
    const format = supportedFormats.find((ext) => name.endsWith(ext));
    if (!format) return [];
    return [{ url, name, bytes: Number(entry?.size_bytes ?? 0) }];
  });
  if (!candidates.length) return { pinnable: false, reason: 'no tabular resource (CSV, JSON, XLSX, Parquet)' };
  const largest = candidates.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  const limit = Number(process.env.PIN_LIMIT_BYTES ?? 95 * 1024 * 1024);
  if (largest.bytes === 0) return { pinnable: true, note: 'unknown size' };
  if (largest.bytes > limit) return { pinnable: false, reason: `resource is ${(largest.bytes / 1024 / 1024).toFixed(0)} MB, above the ${(limit / 1024 / 1024).toFixed(0)} MB pin cap` };
  return { pinnable: true };
};

const cookie = await session();
const datasets = await listPortalDatasets();
console.log(`BetterGov publishes ${datasets.length} datasets; pinning each.`);

const results = [];
for (const dataset of datasets) {
  const started = Date.now();
  let outcome;
  let releaseId;
  const plan = await resourcePlan(dataset.id).catch(() => ({ pinnable: true }));
  if (!plan.pinnable) {
    outcome = `catalogued only (${plan.reason})`;
  } else try {
    // A portal dataset can be large enough to take minutes; one slow source must not stop
    // the rest of the catalog from being pinned.
    const response = await fetch(`${api}/api/v1/connectors/bettergov/pin`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ dataset_id: dataset.id }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const body = await response.json().catch(() => ({}));
    outcome = response.ok
      ? (body.already_pinned ? 'already pinned' : 'pinned')
      : `failed (${response.status} ${body.error ?? ''}${body.message ? `: ${String(body.message).slice(0, 80)}` : ''})`;
    releaseId = body.release_id;
  } catch (error) {
    outcome = `failed (${error?.name === 'TimeoutError' ? 'timed out after 10m' : String(error?.message ?? error)})`;
  }
  if (outcome.startsWith('failed') || outcome.startsWith('catalogued only')) {
    // The dataset still belongs in the catalog: the reader can see what the portal
    // publishes even when its resource cannot be pinned.
    const entry = await fetch(`${api}/api/v1/catalog/entries`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ connector_id: 'bettergov', dataset_id: dataset.id, name: dataset.name,
        description: dataset.description, attribution: dataset.attribution, licence: dataset.licence,
        source_url: `${portal}/datasets/${dataset.id}`, source_updated_at: dataset.updatedAt }),
    }).catch(() => undefined);
    if (entry?.ok || entry?.status === 200) {
      const body = await entry.json().catch(() => ({}));
      outcome = `${outcome} → catalogued as ${body.release_id ?? 'entry'}`;
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ ...dataset, outcome, releaseId });
  console.log(`- ${dataset.name.slice(0, 52).padEnd(52)} ${outcome} (${seconds}s)`);
}

const failed = results.filter((row) => row.outcome.startsWith('failed'));
console.log(`\n${results.length - failed.length}/${results.length} datasets are in the catalog.`);
if (failed.length) {
  console.log('Not pinned (kept visible in this report so they are not silently dropped):');
  for (const row of failed) console.log(`  ${row.id} ${row.name} — ${row.outcome}`);
}
