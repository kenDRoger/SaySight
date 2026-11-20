# Saysight

Saysight turns public datasets into reproducible, reviewable civic findings. MVP-A is implemented for the checksum-verified BetterGovPH GAA coverage release (dataset 27, FY2000–FY2026).

## One-command local setup

Prerequisite: Docker Compose.

```sh
docker compose up --build
```

Compose builds and starts the React/Vite/Kapwa frontend, TypeScript API, Go worker, PostgreSQL, and MinIO-compatible object-storage service. It applies ordered SQL migrations and imports the safe public BetterGov sample into PostgreSQL. The seed import verifies the published SHA-256 before normalization and is idempotent. The worker stores the raw release once as an immutable snapshot in object storage (`saysight/releases/...`) and analyses prefer it, falling back to the checksum-verified local artifact when object storage is unavailable.

- Application: <http://localhost:5173>
- API health: <http://localhost:3000/health>
- MinIO console: <http://localhost:19001>

Local-only database and MinIO development credentials are configured in `docker-compose.yml`; do not use them outside local development. To stop services, use `docker compose down`. To also delete local database and storage volumes, use `docker compose down -v`.

## Components

- `frontend/` — React, TypeScript, Vite, and `@bettergov/kapwa`.
- `api/` — TypeScript catalog, analysis, evidence, finding, account, and review API.
- `worker/` — Go checksum/import validation and deterministic recipe execution.
- `migrations/` — ordered PostgreSQL schema migrations.
- `scripts/` — migration tracking and local database setup; the public sample seed lives in `api/scripts/seed.mjs`.
- `scripts/a11y/` — accessibility and mobile-overflow audit (axe-core via Playwright).

## Accounts and sign-in

MVP-B adds accounts with role-based access. Sign-in is passwordless: the API
issues a single-use, 15-minute magic link, and the browser holds an httpOnly
session cookie for seven days.

```sh
curl -X POST localhost:3000/api/v1/auth/magic-link -H 'content-type: application/json' -d '{"email":"maintainer@example.org"}'
docker compose logs api | grep 'magic link for'
```

No mail transport is configured yet, so the link is written to the API log. Set
`SMTP_*` (deferred) before any non-local deployment; until then a link is only
reachable by whoever can read the logs.

Roles are `submitter`, `reviewer`, and `maintainer`. The account matching
`SAYSIGHT_MAINTAINER_EMAIL` becomes a maintainer on its first sign-in; every
other account starts as a submitter and is promoted by an operator:

```sh
docker compose exec api node scripts/promote.mjs reviewer@example.org reviewer
```

Relevant environment: `SAYSIGHT_MAINTAINER_EMAIL` (first maintainer),
`SAYSIGHT_BASE_URL` (magic-link origin), `COOKIE_SECURE` (set `true` behind
HTTPS). `GET /api/v1/auth/me` reports the signed-in account, and
`POST /api/v1/auth/logout` revokes the session. Accounts require `DATABASE_URL`;
without it the auth endpoints answer `503 accounts_unavailable` rather than
keeping sessions in memory.

## Accessibility audit

With the stack running:

```sh
cd scripts/a11y && npm install && npm run audit
```

It checks the catalog/analysis page and a public finding page at 1280px and 375px, fails on any axe violation or horizontal overflow, and uses Playwright's Chromium unless `BROWSER_PATH` names an installed browser. Set `APP_URL`, `API_URL`, or `WIDTHS` to override the defaults.

The first release is a frozen, checksum-verified source snapshot. Scheduled source refresh and publication of general user uploads are later staged work; see `mvp.md`.
