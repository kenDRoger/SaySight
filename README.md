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
- `api/` — TypeScript catalog, analysis, evidence, and public finding API.
- `worker/` — Go checksum/import validation and deterministic recipe execution.
- `migrations/` — ordered PostgreSQL schema migrations.
- `scripts/` — migration tracking and local database setup; the public sample seed lives in `api/scripts/seed.mjs`.

The first release is a frozen, checksum-verified source snapshot. Scheduled source refresh, authenticated review, and publication of general user uploads are later staged work; see `mvp.md`.
