# ADR 0004: Main-protection keeps only non-fast-forward and deletion protections

## Status

Accepted.

## Context

`main` is protected by a ruleset ("main-protection") that blocks force-pushes
and branch deletion; repository admins bypass it. The release flow already
routes every version bump through a release PR rather than pushing a version
bump straight to `main` - specifically so it would already be compatible with
a `required_status_checks` rule on that ruleset, if one were ever added. The
release job opens that PR, waits for its checks, merges it synchronously in
the same run, then tags and publishes. It is deliberately not auto-merge: the
merge is itself a `GITHUB_TOKEN` action, so the push it produces on `main`
would never trigger a fresh CI run for a second, later job to react to.

That rule was tried. Adding `pull_request` + `required_status_checks` to
main-protection left every check on the release commit (`Gates (Bun)`,
`Built package (Node 24.x)`, `Package contract (packed tarball)`) reporting
success, but GitHub's `mergeable_state` for the release PR's own merge
stayed `blocked` indefinitely - retried for several minutes, and tried again
switching from `gh pr merge` to the raw merge REST endpoint, both failing
identically. Only a repository-admin token (a ruleset bypass actor) could
complete that merge; the token the release workflow runs as is not a bypass
actor, and an Integration bypass actor is rejected unless it is "part of the
ruleset source or owner organization". Reverting the rule live confirmed the
rule itself was the cause: the exact same stuck release PR immediately went
from `mergeStateStatus: blocked` to `unstable` and merged normally on the
very next attempt, with no other change.

## Decision

`main-protection` stays at non-fast-forward + deletion-blocking only.
`required_status_checks` is deliberately not enabled, because the automated
release workflow has no bypass actor that can complete a PR merge under that
rule, and getting stuck there wedges every release behind a human admin
merging by hand.

## Consequences

- Do not re-add `pull_request` + `required_status_checks` to main-protection
  without first solving the merge-actor problem - a repository-owned GitHub
  App registered as a bypass actor is the likely path, not another retry
  loop or a different `gh` invocation; both were tried and both failed the
  same way.
- The release-PR routing (a release PR instead of a direct push to `main`)
  stays regardless of this decision, since it is what any future re-attempt
  would still need and it costs nothing today.
- If this is ever revisited, it needs an owner decision, not an automated
  attempt.
