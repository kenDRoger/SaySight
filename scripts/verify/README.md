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

## Demo-mode browser check

`cd scripts/a11y && BROWSER_PATH=/usr/bin/brave npm run demo` requires an API started
with `SAYSIGHT_DEMO_ROLES=1`. It is not part of `clean-volume.sh`, which runs the default
stack: it asserts the switcher appears before sign-in, that Reviewer lands on the queue,
that a Submitter loses the queue, that Maintainer reaches publication, that no internal
demo address reaches the header, and that axe is clean at 1280px and 375px.

It fails rather than skips when the flag is off, because a check that silently skips
proves nothing.

## Two configurations, not one

`ui.mjs` and `audit.mjs` sign in through the magic link, so they need demo mode **off**;
`demo.mjs` needs it **on**. Both harnesses now refuse to run in the wrong configuration
with a one-line explanation instead of a 30-second timeout, because a suite that fails
for the wrong reason teaches nothing.
