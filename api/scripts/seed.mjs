const api = process.env.API_INTERNAL_URL ?? 'http://api:3000';
const response = await fetch(`${api}/api/v1/datasets/bettergov-gaa-coverage-2026-11-07/import`, { method: 'POST' });
if (!response.ok) {
  console.error(`Sample dataset import failed (${response.status}): ${await response.text()}`);
  process.exit(1);
}
console.log(await response.text());
