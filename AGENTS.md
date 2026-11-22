# Agent rules for Saysight

Review standards for changes in this repository. Keep them short and enforceable.

## Response format (pre-commit reviewer)

Begin your reply with exactly one line, before any reasoning:

    STATUS: PASSED

or

    STATUS: FAILED

Nothing may precede it. The pre-commit hook reads the first 30 lines and blocks the commit
when it cannot find that single line, so a verdict buried under reasoning is treated the same
as no review at all.

## General

- Keep changes inside the requested scope; no unrelated refactors in the same commit.
- One behavior change per commit, with its tests and documentation.
- Never commit generated output (`dist/`, build binaries, `node_modules/`).
- Do not commit secrets. Local development credentials live in `docker-compose.yml` and are explicitly local-only.

## TypeScript (api/, frontend/)

- `strict` TypeScript; no `any` without a narrow cast and a comment explaining why.
- Prefer `const` and small pure functions; name things by what they do.
- Bound every request body before buffering it; reject oversized input explicitly.
- The API contract table at the top of `api/src/server.ts` is maintained by hand and is a
  summary, not an exhaustive enumeration. Do not raise documentation findings about it: an
  error code missing from the summary is never a blocking defect, and this reviewer cannot
  see migrations, tests, or the other modules that define the real contract. Report a
  genuinely undocumented *new* route in one line at most; do not fail the change for it.
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

## Context the reviewer cannot see

The pre-commit review set is the staged change only. These facts live outside it and are
not defects when code appears to violate them:

- **Tests are excluded on purpose** (`EXCLUDE_PATTERNS`). "No test provided" is therefore
  never a finding; every behaviour change in this repository ships with one in
  `api/tests/*.test.ts`, `worker/*_test.go`, or `scripts/a11y/*.mjs`.
- **`release_rows` and `import_rows` are mutable derived data.** The append-only triggers
  cover `dataset_releases`, `analysis_runs`, the evidence tables, `runs`, `insights`, the
  transition/moderation/conflict logs, `explanations`, and the check logs — not the row
  tables, which are rewritten when a release is re-pinned (migrations 005, 016, 023).
- **The join planners enforce cardinality before execution.** `planTwoWayJoin` refuses a
  non-unique right side and any many-to-many or one-to-many pair, so a joined row count can
  never exceed the left side. A cap in the route is defence in depth, not the only guard.
- **The worker is a separate service.** Body, row, and duration limits are enforced there
  as well as at the API; a route that trusts a worker response has still bounded it.
