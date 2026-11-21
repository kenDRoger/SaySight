# Live verification suites

Prerequisite: a running local stack (`docker compose up --build`) with the API on
`:3000`, plus Docker and `python3` on the host. The suites read magic links from
`docker compose logs api` and promote reviewers with `docker compose exec`, so
they must run against the compose stack, not a mock.

Run everything from the repository root:

```sh
python3 scripts/verify/run.py
```

Each suite streams its own output and summary; the runner exits non-zero if any
suite fails (600-second timeout per suite). Individual suites can be run as
`python3 scripts/verify/mvpb_verify.py spec|adversarial` and likewise for `mvpc`
and `mvpd`.

What each suite proves:

- **MVP-B spec**: sign-in and roles, finding submission, review transitions,
  comments and moderation, explanations, and append-only logs.
- **MVP-B adversarial**: magic-link replay and forged tokens, expiry and
  suspension, authorization boundaries, self-review refusal, append-only logs.
- **MVP-C spec**: import validation and quarantine, publication metadata,
  catalog, saved views and pagination, append-only logs.
- **MVP-C adversarial**: forged sessions, publication authorization, missing
  and quarantined drafts, oversized-body rejection, append-only logs.
- **MVP-D spec / adversarial**: curated join diagnostics and evidence,
  relationship validation, rerun determinism, malformed input, append-only logs.

These suites create real rows in the local database — findings, drafts, releases,
and joined evidence — because that is what the API does. Use a local database
you are willing to keep.
