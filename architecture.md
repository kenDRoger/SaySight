# Saysight Architecture

## Purpose and principles

Saysight is a greenfield civic-data platform that turns public datasets into reproducible, reviewable findings. The source release and immutable analysis run are authoritative; workflow state is mutable and evidence/history are append-only. Users never submit arbitrary SQL. AI may explain structured results but never calculates, selects methods, or verifies findings.

## Repository structure

```text
frontend/                 React, TypeScript, Vite, Kapwa UI
api/                      TypeScript public API and workflow coordinator
worker/                   Go worker for bounded expensive workloads
migrations/               PostgreSQL migrations
scripts/                  Migration runner and the accessibility audit
docker-compose.yml        Local PostgreSQL, object storage, and services
```

## System flow

```text
Browser -> TypeScript API/workflow coordinator -> Go worker
                                      |                 |
                                      +-> PostgreSQL     +-> object storage
```

The browser receives bounded JSON: catalog metadata, filter counts, and complete analysis results. Result sets are not paginated in MVP-A; the 1,000,000-row job cap bounds them and pagination is planned for larger datasets. The API owns public reads, catalog metadata, analysis execution, evidence, and findings. The Go worker owns import validation and parsing, normalization, approved recipe execution, and reproducibility checks.

## Frontend

React, TypeScript, Vite, and `@bettergov/kapwa`. The frontend provides the public catalog with dataset detail and field definitions, accessible filters, approachable analysis selection, complete (unpaginated) results for the current bounded dataset, and links to public finding pages. Use Kapwa wherever possible; custom components must preserve accessibility and visual consistency. Charts require accessible table/text alternatives.

Pages must remain lightweight for low-cost phones, older computers, slow networks, and browsers without WebGPU. Never load entire datasets into the browser.

## TypeScript API

The API is a modular monolith and public boundary. It owns catalog and release metadata, public read APIs, analysis execution, evidence persistence, and findings. It validates every input, rejects arbitrary SQL, applies request body and upload concurrency limits, and never treats generated text as evidence. It has no authentication yet: every endpoint is anonymous, and accounts, comments, moderation, review state, and bounded explanations belong to later stages. Worker calls use one bounded retry (`api/src/worker.ts`) so a recreated worker container, which leaves the API holding a dead socket, recovers on the next request instead of returning 503 until the API restarts.

Current endpoints are `/health`, `GET /api/v1/datasets`, `GET /api/v1/recipes`, `GET /api/v1/datasets/:id/preview`, `POST /api/v1/analyze`, `GET /api/v1/evidence/:id`, `POST /api/v1/findings`, `GET /api/v1/findings/:id`, `GET /api/v1/findings/:id/page`, `GET /api/v1/imports/drafts`, `POST /api/v1/imports/register`, `POST /api/v1/imports/validate`, and `POST /api/v1/datasets/:id/import`. Analysis execution reads normalized PostgreSQL coverage rows when `DATABASE_URL` is configured (checksum-verified fixture mode is the explicit local fallback), runs each recipe twice and compares the structured outputs before marking reproducibility `Passed`, persists evidence JSON safely, and keeps evidence readable when the worker is down. Authentication and production deployment wiring remain incomplete.

## Go worker

One containerized modular Go worker handles expensive workloads:

- BetterGov source adapter
- CSV, JSON, XLSX, and Parquet import contract
- File/resource limits and quarantine
- Metadata, schema, and sensitive-data validation
- Normalization into relational analysis tables/views
- Versioned recipes: summary, compare, rank, distribution, change over time
- Reproducibility reruns and validation reports

Every job must enforce file, row, duration, and concurrency limits. Memory and CPU limits are deployment-level (container limits), not in-process. Enforced today: 100 MiB import upload and 1 MiB analyze body caps at the API (HTTP 413 above them, body read with an explicit byte limit) and the same caps again in the worker; a 1,000,000-row cap for imports and analysis jobs (HTTP 422 above it); server duration timeouts of 10s read-header, 5m read, 5m write, and 2m idle; and a concurrency gate of 4 in-flight import/analysis jobs and an API upload gate of 2 in-flight uploads, both rejecting further work immediately with HTTP 429 and `Retry-After` instead of queueing. Failed jobs must not expose partial public data. The worker accepts bounded normalized coverage rows from the API, applies year/status filters, implements safe summary, two-year like-scope comparison, deterministic ranking, status distribution percentages, and comparable adjacent-period changes. It emits explicit pass/fail validation and has an API-level deterministic rerun. Checksum-verified fixture mode remains available when the API has no database. Upload validation/parsing and private-draft registration exist; arbitrary uploaded data is not yet normalized and published.

## Data stores

PostgreSQL stores dataset releases, analysis runs with their evidence JSON, findings, and normalized coverage rows, plus the applied-migration ledger. Migrations `001`–`006` define those tables and the append-only triggers that reject `UPDATE`, `DELETE`, and `TRUNCATE` on releases and analysis runs. Organization, relationship, review-decision, comment, and role tables do not exist yet; they arrive with the stages that need them. The API uses PostgreSQL when `DATABASE_URL` is configured and an in-memory fallback for local development.

The worker stores the raw release once at startup as an immutable snapshot in object storage (`saysight/releases/bettergov-gaa-coverage-2026-11-07/coverage.json`, host ports 19000/19001); an existing object is never overwritten. Analyses prefer the stored snapshot and fall back to the checksum-verified `worker/data/coverage.json` artifact when object storage is unconfigured or unreachable. Both paths pass the same SHA-256 gate. Restricted objects never enter public evidence automatically. Queue/cache infrastructure is optional and must be added only when bounded asynchronous jobs or cached aggregates require it.

## Data contracts

Each release records source, publisher, identifier, checksum, coverage, fields, types, definitions, units, update dates, reuse terms, limitations, and validation status. The initial catalog release is BetterGov dataset 27's GAA coverage resource, CC0 1.0 Universal, FY2000–FY2026, checksum `adeb99733363fce2eba380a21228e69a6cfbc27a40bb685c3c7700f136532d5b`.

Each analysis run records release ID, filters, recipe/version, input/output counts, calculation reference, structured results, warnings, limitations, validation status (`Pass` or `Fail`), and reproducibility status (`Passed`, `Failed`, or `Not run`). A join plan is out of MVP-A scope and arrives with the curated join stage.

## Security, privacy, and governance

Public reads stay anonymous: browse, filter, run supported public analyses, and view public evidence and findings. Accounts exist as of MVP-B: passwordless magic-link sign-in with single-use 15-minute tokens, a seven-day httpOnly session cookie, and three roles (`submitter`, `reviewer`, `maintainer`). The account matching `SAYSIGHT_MAINTAINER_EMAIL` becomes a maintainer on first sign-in and other roles are granted only by `api/scripts/promote.mjs`; no endpoint assigns roles. No mail transport is wired yet, so the magic link is written to the API log, finding submission requires a session and records its author, and reviewer decisions require a reviewer or maintainer session, a mandatory reason, and a legal transition, with every change appended to `finding_transitions`. Comments publish immediately and are removed only by a reviewer or maintainer with a recorded reason, kept in an append-only moderation log. Review depth is derived from the evidence's year coverage, so a finding about the whole series needs two independent reviewers, and a disagreement between reviewers is stored in `review_conflicts` instead of being settled silently. Bounded explanations rephrase an existing result, are bounded to 600 characters, and fall back to a deterministic template when no provider is configured or the provider errors, times out, or returns oversized text; each generation is stored in the append-only `explanations` table with its provider, model, and template version and is never treated as evidence. The interface covers sign-in, authenticated submission, the reviewer queue, decisions, history, and comments in the same single-page app, and stays at zero axe violations with no horizontal overflow at 1280px and 375px. An external identity provider remains deferred.

Upload validation and private-draft registration exist and store drafts without publishing them; no upload is normalized or published automatically, and quarantine policy is planned with the general-import stage.

## Deployment and operations

Use portable containers. `docker compose up --build` starts the frontend, API, Go worker, PostgreSQL, and object storage, then applies ordered migrations and runs the idempotent checksum-verified seed. Verified in a clean volume: migrations apply in order, seed imports 27 rows and repeats safely, all five recipes run, evidence JSON and Unverified finding pages are served, and the frontend proxies to the API. Object storage is pinned to `chainguard/minio` (MinIO no longer publishes community images) and maps host ports 19000/19001. Worker and API containers carry deployment-level CPU/memory limits; the worker image is a static binary rather than a runtime `go run`. The local compose stack runs the Vite dev server, the API under `tsx`, a static Go worker binary, PostgreSQL, and object storage; production builds exist and are checked, while production hosting is deferred. Source outages preserve existing evidence and cached views but block new analyses when the exact release cannot be confirmed.

Every feature specification must document expected device, bandwidth, browser CPU/memory, server compute, storage, hosting-cost implications, accessibility impact, privacy/security impact, and low-resource fallback.

## Testing

Test public interfaces and observable outcomes. MVP-A covers recipe examples, validation failures, rejected-import preservation, evidence immutability, job limits, request caps, the upload gate, release checksum/snapshot loading, and accessible alternatives; authorization and review-transition tests arrive with MVP-B. Current checks include 29 Go tests (recipes, validation, import parsing, evidence, job limits, and release checksum/snapshot loading), 7 API tests (bounded worker retry and the upload gate), frontend/API production builds, manual database-backed recipe/evidence smoke runs, and the committed accessibility audit in `scripts/a11y` (axe-core via Playwright, authenticated via `AUDIT_SESSION`), which reports zero violations and no horizontal overflow on the catalog/analysis and public finding pages at 1280px and 375px. Seed idempotency is checked by running the seed service twice against a populated database. Authenticated workflow tests are deferred to MVP-B. The migration 013 impact backfill and the app's explanation controls have no automated behavioral test yet; the frontend change in this pass was checked with `npx tsc -p tsconfig.json --noEmit` and `npm run build` only.

## Planned (not implemented)

Everything below is documented intent, not current behaviour. It appears here so
the descriptions above stay truthful.

- **MVP-B (in progress):** accounts and role-based access, magic-link sign-in,
  sessions, the maintainer bootstrap, authenticated finding submission, the
  review queue, reviewer decisions with mandatory reasons, and append-only
  review history, impact-based review depth, conflict-resolution records, and
  bounded explanations with a deterministic fallback, and the MVP-B interface
  exist. Remaining before MVP-B acceptance: four verification passes.
- **MVP-C:** general CSV/JSON/XLSX/Parquet normalization and publication,
  upload quarantine policy, metadata validation, trusted-maintainer controls, a
  multi-agency catalog, pagination for larger result sets, a shared contracts
  package, a `docs/` directory, and cross-component test tooling.
- **MVP-D:** one curated cross-dataset join with explicit keys, diagnostics, and
  joined evidence.

## Delivery stages

- **MVP-A:** catalog, BetterGov adapter, one verified release, normalized storage, filters, five recipes, validation, evidence preview, public findings, accessibility/resource checks.
- **MVP-B:** accounts, submissions, review queue, decisions, immutable history, conflict resolution, bounded explanations with deterministic fallback.
- **MVP-C:** general imports, uploads, quarantine, metadata validation, maintainer controls, multi-agency catalog.
- **MVP-D:** one curated cross-dataset join with diagnostics and joined evidence.

MVP-C and MVP-D begin only after MVP-A and MVP-B acceptance checks pass.

## Current status

MVP-A's single-dataset workflow is accepted for the fixed initial BetterGov dataset 27 GAA coverage release (CC0 1.0 Universal, checksum recorded above). The adapter imports the immutable verified release; live/scheduled refresh is deferred. PostgreSQL normalized rows are the analysis source when configured, with the checksum-verified local artifact as development fallback. The five recipes are bounded and source-aware; tests cover safe summaries, scope-matched comparison, stable ranking ties, distribution percentages, adjacent comparable trends, and validation failures. The API reruns calculations before recording `Passed`; evidence persists release checksum, filters, calculation, recipe/version, counts, result, validation, warnings, limitations, and reproducibility. Targeted browser flow and axe audits passed for catalog/analysis and public findings at desktop and mobile width. Arbitrary upload publication and maintainer approval belong to MVP-C; accounts/reviewer workflow belong to MVP-B; these are not MVP-A acceptance blockers. The API requires `DATABASE_URL` for durable evidence; the documented in-memory fallback is development-only. Within the in-progress MVP-B work, migration 013 defines a one-way backfill of legacy `findings.impact` from analysis-run filters, and the single-page app shows the latest explanation with its source, provider/model, and template version. Migration 013 has not been applied to the running stack in this pass, and magic links are still log-only (no SMTP), so a real deployment cannot sign in until a mail transport is added.
