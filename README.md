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
- Worker health (published for local route tests): <http://localhost:8080/health>

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

There is no mail transport (no SMTP): the link is written to the API log. A real
deployment cannot sign in until a mail transport is added (`SMTP_*` is deferred);
until then a link is only reachable by whoever can read the logs.

Roles are `submitter`, `reviewer`, and `maintainer`. The account matching
`SAYSIGHT_MAINTAINER_EMAIL` becomes a maintainer on its first sign-in; every
other account starts as a submitter and is promoted by an operator:

```sh
docker compose exec api node scripts/promote.mjs reviewer@example.org reviewer
```

Submitting a finding requires a session (`POST /api/v1/findings` answers
`401 sign_in_required` anonymously) and records the author on the finding.

Relevant environment: `SAYSIGHT_MAINTAINER_EMAIL` (first maintainer),
`SAYSIGHT_BASE_URL` (magic-link origin), `COOKIE_SECURE` (set `true` behind
HTTPS). `GET /api/v1/auth/me` reports the signed-in account, and
`POST /api/v1/auth/logout` revokes the session. Accounts require `DATABASE_URL`;
without it the auth endpoints answer `503 accounts_unavailable` rather than
keeping sessions in memory.

## Review workflow

Findings move through `Unverified` → `Pending verification` → `In review` →
`Verified`, `Needs correction`, `Rejected`, or `Insufficient evidence`. Terminal
statuses accept no further change; `Needs correction` sends the finding back to
`Pending verification`.

- `GET /api/v1/review/queue` — reviewer or maintainer only; excludes your own
  submissions.
- `POST /api/v1/findings/:id/decisions` — `{ "status": "In review", "reason": "..." }`;
  the reason is mandatory and recorded.
- `GET /api/v1/findings/:id/history` — the append-only decision history, also
  rendered on the public finding page.

Nobody reviews their own submission, whatever their role, and a submitter cannot
decide anything. `finding_transitions` rejects `UPDATE`, `DELETE`, and `TRUNCATE`,
so history cannot be rewritten.

### Review depth and disagreement

Every finding carries an impact level derived from its evidence, never chosen by
the submitter: no year filter speaks for the whole series (`high`), all 27 years
are `high`, several but not all years are `standard`, one year is `low`.
Migration `013_backfill_impact.sql` recomputes legacy findings' impact from
their evidence filters when the ordered migrations run. A `high` finding needs two independent
reviewers — the first terminal decision is recorded but does not settle the
finding — and when two reviewers reach different decisions both positions are
kept in the append-only `review_conflicts` table and shown on the public page.

### Comments

- `GET /api/v1/findings/:id/comments` — public list; removed comments stay in place
  with their text dropped and the removal reason shown.
- `POST /api/v1/findings/:id/comments` — signed in; `{ "body": "..." }`.
- `POST /api/v1/comments/:id/removal` — reviewer or maintainer; `{ "reason": "..." }`.

Comments are visible immediately (post-moderation) and only reviewers and
maintainers can remove one, with a mandatory reason recorded in the append-only
`comment_moderation` log. Pre-moderation remains the documented alternative if
BetterGov prefers it, and the `comments.status` column already allows it.

### Explanations

- `POST /api/v1/findings/:id/explanation` — signed in; generates and stores a
  bounded explanation of the finding's existing result.
- `GET /api/v1/findings/:id/explanation` — public; `{ "explanation": record | null }`,
  the latest one.

The text only rephrases the structured result already stored as evidence. It
never calculates, selects a recipe, or decides a status, and it is never treated
as evidence itself — the latest explanation is shown on the public finding page
under its own heading, above the comments. The app's finding detail section also
shows the latest explanation with its source, provider/model when present, and
template version; signed-in users can generate one there.

The deterministic template answers whenever no provider is configured or the
provider fails, times out, or returns oversized or invalid text, so the feature
works with no network and no API key. Each generation is stored in the
append-only `explanations` table with its provider, model, and template version,
and the page says which source a reader is looking at.

Environment: `EXPLANATION_PROVIDER_ENDPOINT` and `EXPLANATION_PROVIDER_MODEL`
(both required to enable a provider), `EXPLANATION_PROVIDER_NAME` (default
`openai-compatible`), `EXPLANATION_API_KEY`, and `EXPLANATION_TIMEOUT_MS`
(default `8000`). `docker-compose.yml` carries all the `EXPLANATION_*` variables
but configures no provider by default (endpoint and model are empty), so text
falls back to the deterministic template until both are set.

## General uploads (MVP-C)

Draft registration requires a session. The API accepts only `.csv`, `.json`,
`.xlsx`, and `.parquet`, enforces the 100 MiB body and 1,000,000-row caps before
normalization, and records a validation report for every draft.

- `POST /api/v1/imports/register?filename=<name>&name=<name>` — private draft;
  `400 unsupported_format` for other extensions, `401 sign_in_required`
  anonymously.
- `POST /api/v1/imports/validate?filename=<name>` — parse-only validation, also
  public for the MVP-A compatibility path.
- A draft whose parsed row count is zero is `quarantined` with a machine-readable
  reason in the append-only `quarantine_records` table; an empty dataset is
  `schema_invalid`, and more than 1,000,000 rows is `row_limit_exceeded`.
- Only a maintainer can publish a validated draft; that control arrives with the
  next task. General uploads are never normalized or published automatically.

## Accessibility audit

With the stack running:

```sh
cd scripts/a11y && npm install && npm run audit
```

It checks the catalog/analysis page and a public finding page at 1280px and 375px, fails on any axe violation or horizontal overflow, and uses Playwright's Chromium unless `BROWSER_PATH` names an installed browser. Set `APP_URL`, `API_URL`, or `WIDTHS` to override the defaults.

The audit signs itself in through the magic-link flow and reads the link from the API log, so no cookie needs to be pasted. Set `AUDIT_SESSION` only to skip that flow. `npm run ui` runs the browser interaction checks (reviewer gating, comment moderation, explanation provenance) against the same stack.

The first release is a frozen, checksum-verified source snapshot. Scheduled source refresh and publication of general user uploads are later staged work; see `mvp.md`.
