#!/bin/bash
# Clean-volume verification: builds an isolated Compose project from scratch,
# runs every suite against it, then restores the original stack. Exits non-zero
# if any step fails, so a failing pass can never look green.
set -uo pipefail
cd "$(dirname "$0")/../.."

status=0
fail() { echo "FAILED: $*"; status=1; }

restore() {
  echo "--- removing the verification stack and restoring the original ---"
  COMPOSE_PROJECT_NAME=saysight-v4 docker compose down -v >/dev/null 2>&1 || true
  env -u COMPOSE_PROJECT_NAME docker compose down >/dev/null 2>&1 || true
  env -u COMPOSE_PROJECT_NAME docker compose up -d >/dev/null 2>&1 || true
}
trap restore EXIT

echo "--- stopping original stack (volumes kept) ---"
env -u COMPOSE_PROJECT_NAME docker compose down >/dev/null 2>&1

export COMPOSE_PROJECT_NAME=saysight-v4
docker compose down -v >/dev/null 2>&1 || true
echo "--- building a virgin stack ---"
docker compose up --build -d >/tmp/v4-up.log 2>&1 || { tail -40 /tmp/v4-up.log; echo V4_BUILD_FAILED; exit 1; }

for _ in $(seq 1 90); do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1 && curl -sf http://localhost:8080/health >/dev/null 2>&1 && curl -sf http://localhost:5173 >/dev/null 2>&1; then break; fi
  sleep 2
done
echo -n "health: "
curl -s -o /dev/null -w 'api=%{http_code} ' http://localhost:3000/health || fail "api health"
curl -s -o /dev/null -w 'worker=%{http_code} ' http://localhost:8080/health || fail "worker health"
curl -s -o /dev/null -w 'app=%{http_code}\n' http://localhost:5173 || fail "app health"

echo -n "migrations applied: "
docker compose exec -T postgres psql -U saysight -d saysight -Atc "SELECT count(*) FROM schema_migrations" || fail "migration count"
echo -n "seeded coverage rows: "
docker compose exec -T postgres psql -U saysight -d saysight -Atc "SELECT count(*) FROM coverage_records" || fail "seed count"
echo -n "seed idempotency: "
docker compose run --rm seed >/dev/null 2>&1 && echo "second run ok" || fail "seed rerun"

echo "--- Go tests ---"
(cd worker && go test ./... -count=1 | tail -1) || fail "go tests"
echo "--- API tests ---"
(cd api && npm test >/tmp/v4-api-tests.log 2>&1) || fail "api tests"
grep -E '^. (tests|pass|fail|skipped)' /tmp/v4-api-tests.log
grep -q '^. fail 0' /tmp/v4-api-tests.log || fail "api test failures"

echo "--- stage verification suites ---"
python3 scripts/verify/run.py >/tmp/v4-suites.log 2>&1 || fail "verification suites"
tail -2 /tmp/v4-suites.log

echo "--- browser and accessibility ---"
(cd scripts/a11y && BROWSER_PATH=/usr/bin/brave npm run ui >/tmp/v4-ui.log 2>&1) || fail "ui checks"
grep -c '^OK' /tmp/v4-ui.log | sed 's/^/ui checks: /'
(cd scripts/a11y && BROWSER_PATH=/usr/bin/brave npm run audit >/tmp/v4-audit.log 2>&1) || fail "accessibility audit"
tail -1 /tmp/v4-audit.log

if [ "$status" -eq 0 ]; then echo "V4_OK"; else echo "V4_FAILED"; fi
exit "$status"
