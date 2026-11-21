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

## First-run guidance

The landing page opens with a three-step guide (explore → run → compare) and states
that browsing and analysis are anonymous, so a new visitor knows what the MVP does
before signing in. The verified BetterGov release is featured above the full
release list, which stays collapsed behind a disclosure; test fixtures carry a
`Test data` badge. No tour, modal, or new dependency is involved.

## Components

- `frontend/` — React, TypeScript, Vite, and `@bettergov/kapwa`.
- `api/` — TypeScript catalog, analysis, evidence, finding, account, and review API.
- `worker/` — Go checksum/import validation and deterministic recipe execution.
- `migrations/` — ordered PostgreSQL schema migrations.
- `scripts/` — migration tracking and local database setup; the public sample seed lives in `api/scripts/seed.mjs`.
- `scripts/a11y/` — accessibility and mobile-overflow audit (axe-core via Playwright) plus browser interaction checks.
- `scripts/verify/` — the stage verification suites (MVP-B, MVP-C, MVP-D spec and adversarial) with one runner: `python3 scripts/verify/run.py`.

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
- `POST /api/v1/imports/:id/publish` — maintainer only; body
  `{ "reason": "...", "metadata": { publisher, sourceUrl, license, coverage, fields, limitations } }`.
  Incomplete metadata is refused with `400 invalid_metadata` and the failing
  field names. Publication creates a **new** release and records the decision in
  the append-only `publication_decisions` log; the draft becomes `published`.
  A validated, non-quarantined draft is normalized into `import_rows`, one JSONB
  row per source row, through the worker's bounded `/normalize-import` endpoint.

## Catalog metadata and saved views

`GET /api/v1/agencies` lists the seeded agencies. Each catalog entry now carries
its agency, region, freshness status, and last-checked date; the verified
BetterGov release uses its checksum-verified catalog record when a legacy row
does not yet have those columns.

Signed-in users can save a filtered view:

```sh
curl -b cookies.txt -X POST localhost:3000/api/v1/saved-views \
  -H 'content-type: application/json' \
  -d '{"name":"FY2024","datasetReleaseId":"bettergov-gaa-coverage-2026-11-07","filters":{"year":2024}}'
```

`GET /api/v1/saved-views` returns only the caller's views. Saved views are
workflow state, not evidence.

### Pagination

`GET /api/v1/datasets`, `/api/v1/review/queue`, `/api/v1/findings/:id/comments`,
and `/api/v1/saved-views` accept optional `limit` (1–100) and `offset` (>= 0).
With neither parameter the response is unchanged; invalid values return
`400 invalid_pagination`. Row caps still bound how much data enters the system.

### Response contracts

There is no shared contracts package: API response shapes are pinned by
`api/tests/http.test.ts`, and the browser-facing behaviour is pinned by
`scripts/a11y/ui.mjs` and `audit.mjs`. Keep a new type in one place unless a
second component genuinely needs it.

## Accessibility audit

With the stack running:

```sh
cd scripts/a11y && npm install && npm run audit
```

It checks the catalog/analysis page and a public finding page at 1280px and 375px, fails on any axe violation or horizontal overflow, and uses Playwright's Chromium unless `BROWSER_PATH` names an installed browser. Set `APP_URL`, `API_URL`, or `WIDTHS` to override the defaults.

The audit signs itself in through the magic-link flow and reads the link from the API log, so no cookie needs to be pasted. Set `AUDIT_SESSION` only to skip that flow. `npm run ui` runs the browser interaction checks (reviewer gating, comment moderation, explanation provenance) against the same stack.

The first release is a frozen, checksum-verified source snapshot. Scheduled source refresh and publication of general user uploads are later staged work; see `mvp.md`.

## Curated join

`POST /api/v1/join/analyze` runs one curated join of the verified BetterGov GAA
coverage release with a **synthetic test fixture** on the explicit
`fiscal_year` key. The fixture is labeled as test data in the catalog and is not
a real government dataset. Join keys are declared in the relationship record;
the API accepts no SQL and no alternative release pair.

The response reports matched and unmatched rows, duplicate right-side keys,
validation, and reproducibility. The worker runs the recipe twice and the API
writes one append-only `joined_evidence` row tied to a new analysis run; a new
release or recipe version creates a new run rather than updating an existing
one. Evidence exposes counts and the explicit keys, not raw joined rows.

## Documentation boundaries

`mvp.md`, `architecture.md`, `concept.md`, `ideas.md`, and `guidelines.md` are the
owner's source-of-truth documents and are intentionally kept outside this
repository. This README is the repository-facing operating guide; there is no
`docs/` tree because the owner keeps a separate backup of design documents.

## Demo mode (local only, not for deployment)

To move between submitter, reviewer, and maintainer without the email round trip:

```bash
SAYSIGHT_DEMO_ROLES=1 docker compose up -d api
```

Switch roles from the top bar. The badge reads **Demo mode**, and the same
authorization rules apply as in the real flow — you still cannot review your own
finding, and a high-impact finding still needs a second reviewer.

This grants maintainer access to anyone who can reach the API. It is off by default and
must never be deployed enabled; see `architecture.md` for the exact removal steps.
