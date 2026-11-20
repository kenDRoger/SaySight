# Agent rules for Saysight

Review standards for changes in this repository. Keep them short and enforceable.

## General

- Keep changes inside the requested scope; no unrelated refactors in the same commit.
- One behavior change per commit, with its tests and documentation.
- Never commit generated output (`dist/`, build binaries, `node_modules/`).
- Do not commit secrets. Local development credentials live in `docker-compose.yml` and are explicitly local-only.

## TypeScript (api/, frontend/)

- `strict` TypeScript; no `any` without a narrow cast and a comment explaining why.
- Prefer `const` and small pure functions; name things by what they do.
- Bound every request body before buffering it; reject oversized input explicitly.
- Every new public endpoint documents its status codes and error shape.
- Keep the API a public boundary: validate input, never accept arbitrary SQL.

## React (frontend/)

- Function components with hooks; no classes.
- Interactive controls need labels, keyboard access, and visible focus.
- Tables need captions and header scopes; scrollable regions must be keyboard focusable.
- No layout that overflows horizontally at 375px.

## Go (worker/)

- Explicit error returns; never ignore an error that changes behavior.
- Bound expensive work: rows, duration, concurrency, and request size.
- Verify checksums before using release bytes; keep one gate for both storage paths.
- Table-driven tests for parsing and recipes; no sleeps in tests.

## SQL (migrations/)

- Migrations are ordered, immutable once applied, and wrapped in a transaction by the runner.
- Append-only tables reject `UPDATE`, `DELETE`, and `TRUNCATE`.
- Add indexes for the access paths the code actually uses.

## Tests

- Test observable behavior through public interfaces.
- Each test asserts every effect of the rule it covers, including rejected input leaving state unchanged.
- A bug fix ships with a test that fails before the fix.
