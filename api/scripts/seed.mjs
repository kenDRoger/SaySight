// Imports the verified sample release into normalized analysis tables.
//
// That route writes to the catalog, so it requires a maintainer session. The seed signs in
// through the magic-link log (the same path a maintainer uses) rather than assuming an
// anonymous write, which the API refuses.
import { execFileSync } from 'node:child_process';

const api = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3000';
const email = process.env.SAYSIGHT_MAINTAINER_EMAIL ?? 'maintainer@example.org';
const composeFile = process.env.COMPOSE_FILE ?? 'docker-compose.yml';
const release = 'bettergov-gaa-coverage-2026-11-07';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function session() {
  for (let round = 0; round < 8; round += 1) {
    const requested = await fetch(`${api}/api/v1/auth/magic-link`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    });
    if (!requested.ok) throw new Error(`magic-link request failed: ${requested.status}`);
    const marker = `magic link for ${email}: `;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const logs = execFileSync('docker', ['compose', '-f', composeFile, 'logs', 'api', '--since', '2m'], { encoding: 'utf8', timeout: 5000 });
      const line = logs.split('\n').reverse().find((entry) => entry.includes(marker));
      if (line) {
        const link = line.slice(line.indexOf(marker) + marker.length).trim();
        const verified = await fetch(link.replace(/^.*\/api/, `${api}/api`), {
          headers: { accept: 'application/json' }, redirect: 'manual',
        });
        const cookie = verified.headers.get('set-cookie');
        if (cookie) return cookie.split(';')[0].split('=')[1];
      }
      await sleep(300);
    }
    // The fixed maintainer address has a 60-second cooldown; wait it out and retry.
    await sleep(8000);
  }
  throw new Error('could not obtain a maintainer session from the magic-link log');
}

const cookie = await session();
const response = await fetch(`${api}/api/v1/datasets/${release}/import`, {
  method: 'POST', headers: { cookie: `saysight_session=${cookie}` },
});
if (!response.ok) {
  console.error(`Sample dataset import failed (${response.status}): ${await response.text()}`);
  process.exit(1);
}
console.log(await response.text());

// The insights path reads release_rows and their stored schema. Normalization writes the
// coverage table only, so the seed also publishes the rows and the declared types; without
// them the flagship release is listed and every recipe skips it.
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://saysight:saysight-dev-only@localhost:5432/saysight' });
try {
  await pool.query(`
    INSERT INTO release_rows (release_id, row_number, data)
    SELECT $1, row_number() OVER (ORDER BY fiscal_year),
           jsonb_build_object('fiscal_year', fiscal_year, 'coverage_status', coverage_status,
                              'source_row_count', source_row_count, 'amount_pesos', amount_pesos, 'notes', notes)
    FROM coverage_records WHERE dataset_release_id = $1 ON CONFLICT DO NOTHING`, [release]);
  // The curated fixture analyses the same 27 fiscal years, so it needs the same rows:
  // a two-release run refuses a release with none.
  await pool.query(`
    INSERT INTO release_rows (release_id, row_number, data)
    SELECT 'join-fixture-2026-11-07', row_number() OVER (ORDER BY fiscal_year),
           jsonb_build_object('fiscal_year', fiscal_year, 'population', source_row_count * 1000)
    FROM coverage_records WHERE dataset_release_id = 'join-fixture-2026-11-07'
    ON CONFLICT DO NOTHING`);
  await pool.query(
    `INSERT INTO dataset_releases (id, name, publisher, source_url, release_id, checksum, reuse_terms, status, metadata)
     SELECT id, name, publisher, source_url, release_id, checksum, reuse_terms, status,
            jsonb_set(metadata, '{schema}', $1::jsonb, true)
     FROM dataset_releases WHERE id = 'join-fixture-2026-11-07' AND metadata->'schema' IS NULL
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify({ columns: [{ name: 'fiscal_year', type: 'integer' }, { name: 'population', type: 'number' }] })],
  );
  const rows = await pool.query('SELECT count(*)::int AS n FROM release_rows WHERE release_id = $1', [release]);
  const fixture = await pool.query("SELECT count(*)::int AS n FROM release_rows WHERE release_id = 'join-fixture-2026-11-07'");
  console.log(`Stored ${rows.rows[0].n} analysis rows for ${release} and ${fixture.rows[0].n} for the fixture.`);
} finally {
  await pool.end();
}
