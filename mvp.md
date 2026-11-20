# Saysight MVP

## Goal

Deliver a public, low-resource web application that lets a citizen or civic researcher produce one reproducible, reviewable finding from a cataloged public dataset.

The MVP is staged. The single-dataset workflow must pass before uploads and cross-dataset joins begin.

## Architecture baseline

- Frontend: React, TypeScript, Vite, and `@bettergov/kapwa`.
- Public API/workflow coordinator: TypeScript modular monolith.
- Expensive workloads: one modular Go worker for imports, validation, normalization, approved recipes, and joins.
- PostgreSQL: catalog, normalized analysis data, metadata, evidence, findings, review, and permissions.
- Object storage: raw releases and immutable snapshots.
- Portable containers and one-command local setup with safe sample data.
- Hosting and identity provider are deferred.

## MVP-A — Single-dataset evidence workflow

### Scope

- Catalog page with dataset detail, coverage range, and field definitions.
- BetterGov Open Data source adapter.
- Verified GAA coverage release for FY2000–FY2026 (dataset 27, CC0 1.0 Universal) with required metadata and checksum.
- Normalized relational analysis tables.
- Dataset-specific filters with selected values and matching row count.
- Five approved recipes: summary/profile, two-group comparison, multi-group ranking, distribution, and change over time.
- Validation, warnings, limitations, and reproducibility status.
- Immutable analysis run and evidence preview.
- Public finding pages and catalog pages.
- Accessibility and low-resource behavior.

### Acceptance criteria

- A user can discover a dataset, inspect its source and limitations, select only available filters, and see the matching row count.
- Each recipe validates inputs and uses bounded, versioned deterministic SQL or equivalent approved execution.
- A successful rerun records `Passed`; validation exposes `Pass` or `Fail`, and a missing rerun exposes `Not run`.
- Failed validation blocks submission; warnings remain visible.
- Evidence includes release/checksum, filters, recipe/version, row counts, result, validation, warnings, limitations, and reproducibility.
- No entire dataset is sent to the browser.
- Public pages work without an account and have accessible table/text alternatives.
- Existing evidence remains readable when the upstream source is unavailable.

### Current status

**MVP-A is accepted for the fixed initial BetterGov dataset release**: dataset 27's GAA coverage resource, CC0 1.0 Universal, SHA-256 `adeb99733363fce2eba380a21228e69a6cfbc27a40bb685c3c7700f136532d5b`.
Verified against this scope:

- The public catalog exposes the dataset source, release, checksum, terms, fiscal-year coverage, fields, and limitations. The release imports into normalized PostgreSQL; the analysis API reads those rows through fixed SQL when `DATABASE_URL` is configured. The checksum-verified local artifact is the explicit development fallback.
- Year/status filters show selected values and matching-row counts before analysis; comparisons let the user choose two fiscal years.
- All five recipes have deterministic, source-aware behavior: safe summary/profile; two-year comparison only for matching status/scope; stable ranking ties; category counts and percentages; and period changes only for adjacent matching-coverage periods.
- Validation failures return `Fail` (reproducibility `Failed`) and prevent evidence creation. Successful analyses are rerun and only marked `Passed` when the structured results match. Evidence records source checksum, filters, calculation, recipe/version, input/output rows, validation, warnings, limitations, and reproducibility.
- Public Unverified finding pages expose source, checksum, recipe/version, calculation, filters, row counts, validation, result, warnings, and limitations. Existing evidence remains readable when the analysis worker is unavailable; new runs return `Not run`/HTTP 503.
- Production frontend/API builds and 29 Go tests plus 7 API tests pass. Dataset checksum and PostgreSQL import (27 rows) are verified. Migrations 001–006 apply in order; append-only triggers reject analysis-run and release UPDATE, DELETE, and TRUNCATE. Job limits are enforced at the API and the worker: 100 MiB import and 1 MiB analyze body caps (HTTP 413 above them), a 1,000,000-row cap for imports and analysis, server duration timeouts, and a worker gate of 4 in-flight jobs and an API gate of 2 in-flight uploads that reject excess work with HTTP 429. The committed audit in `scripts/a11y` (axe-core via Playwright) reports zero violations on the catalog/analysis page and a public finding page at 1280px and 375px, with no horizontal overflow at either width. The catalog page shows dataset detail metadata, coverage range, and field definitions with table alternatives. Production assets are 79.79 KB gzip JavaScript and 9.77 KB gzip CSS; no raw budget line-item dataset is sent to the browser.

The MVP-A boundary is one immutable release and its public analyses; automatic source refresh is not included. One-command local setup is verified from a clean volume (`docker compose up --build`): migrations apply in order, the seed imports 27 rows and is idempotent, all five recipes run, evidence and Unverified finding pages are served, and the frontend reaches the API. The raw release is stored once as an immutable object-storage snapshot and analyses prefer it, with the checksum-verified local artifact as the explicit fallback. Source-freshness fields and separate source/dataset/release records (`ideas.md` step 1), agency/region exploration with saved views (`ideas.md` step 2), result pagination, and finding claim/flag-for-review fields are deferred to MVP-B/C as named in `architecture.md`'s planned section. General CSV/JSON/XLSX/Parquet upload normalization/publication and maintainer approval belong to MVP-C; accounts and reviewer workflow belong to MVP-B. MVP-A is accepted for the fixed release and scope above.

**MVP-B is in progress.** Accounts, role-based access, passwordless magic-link sign-in, sessions, the `SAYSIGHT_MAINTAINER_EMAIL` bootstrap, and `api/scripts/promote.mjs` are implemented and verified (migration `007_accounts.sql`, 10 auth tests, live sign-in/verify/replay/logout checks). Authenticated finding submission records the author and rejects anonymous writes with `401` (migration `008`). The review queue, reviewer decisions with mandatory reasons, the state machine, and the append-only transition history are implemented (migration `009`, 9 review tests, live checks: submitter `403`, missing reason `400`, skipped step `409`, self-review `403`, reviewer-authored findings excluded from the queue, history `UPDATE` rejected). Comments are implemented with post-moderation (migration `010`, live checks: anonymous `401`, empty body `400`, submitter removal `403 moderator_required`, moderator removal `200`, repeat removal `409`, unknown comment `404`, removed text dropped from the public list and page, moderation log rejecting `UPDATE`). Impact-based review depth and conflict-resolution records are implemented (migration `011`, live checks: unfiltered submission derives `high` while a single year derives `low`, a high-impact finding stays `In review` after one terminal decision, a second reviewer settles it, the disagreement is stored in the append-only `review_conflicts` table and shown on the public page, and a low-impact finding is settled by one reviewer). Bounded explanations are implemented (migration `012`, live checks: anonymous `POST` `401`, `GET` before generation `null`, signed-in generation `source: template`, 600-character bound enforced, public page renders the section, append-only log rejects `UPDATE`; the model path is pinned by 5 unit tests covering success and every fallback condition). The review UI is implemented in the existing single-page app (sign-in, session state, authenticated submission, reviewer queue with legal-status decisions and mandatory reasons, decision history, comments with moderator removal) and the committed audit still reports zero axe violations and no horizontal overflow at 1280px and 375px; production assets are 82.12 KB gzip JavaScript and 9.90 KB gzip CSS. Migration `013_backfill_impact.sql` recomputes legacy findings' impact from their analysis-run filters, and the finding detail now shows the latest explanation with its provenance. The magic-link transport remains log-only (no SMTP), so a real deployment cannot sign in until one is added. Migration 013 and the new explanation controls have not had a live-stack verification pass in this change. MVP-B is implemented end to end and now goes through four verification passes.

## MVP-B — Accounts and public review

Begin only after MVP-A acceptance checks pass.

- Accounts and role-based access.
- Authenticated finding submission.
- Review queue and designated reviewer access.
- `Unverified` → `Pending verification` → `In review` → `Verified`, `Needs correction`, `Rejected`, or `Insufficient evidence`.
- Mandatory decision reasons and append-only history.
- Moderated contextual comments.
- Impact-based review depth and conflict-resolution records.
- Bounded explanations with deterministic fallback.

## MVP-C — General imports and multi-agency catalog

Begin only after MVP-A and MVP-B acceptance checks pass. Add reusable CSV, JSON, XLSX, and Parquet imports, private/draft uploads, quarantine, metadata validation, trusted-maintainer controls, and multiple agencies.

## MVP-D — One curated cross-dataset join

Begin only after MVP-A and MVP-B acceptance checks pass. Add one primary plus one cataloged related dataset, explicit join keys, diagnostics, bounded joined recipes, and joined evidence.

## Cross-cutting requirements

Every feature specification must state expected device, bandwidth, browser CPU/memory, server compute, storage, hosting cost, accessibility impact, privacy/security impact, and low-resource fallback. Evidence is append-only; workflow state is separate. New releases or recipe versions create new analysis runs and never silently update existing findings.
