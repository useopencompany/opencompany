# ADR 0017: GitHub Actions Runner Provider

- Status: Accepted
- Date: 2026-09-23
- Related: [CI security](../ci-security.md)

## Context

We run every heavy CI job on Blacksmith (`blacksmith-4vcpu-ubuntu-2404`). The question was
whether moving to Depot would make the pull-request gate faster.

It is a reasonable thing to ask. Depot is a good product and its GitHub Actions runners are
genuinely quick. But "which runner is fastest" is only the right question if the runner is what
is costing us time. So before comparing vendors, we measured where the gate's time actually
goes.

The sample is the `PR Gate` workflow: 60 successful runs since 2026-09-10 for job-level timing,
and the 40 most recent for step-level timing. All figures are seconds.

### Where the gate's time goes

| Job         | p50 | p90 | of which cache restore (p50 / p90) |
| ----------- | --- | --- | ---------------------------------- |
| Build       | 175 | 364 | 94 / 262                           |
| Test        | 106 | 254 | 16 / 33                            |
| Static      |  87 | 165 | 16 / 37                            |
| Policy      |  30 |  51 | 11 / 30                            |
| Secret scan |  15 |  23 | — / —                              |

The five jobs run in parallel, so wall-clock is roughly the slowest one: `Build`. Queue time to
pick up a runner is a p50 of 13s and a p90 of 21s.

## Decision

**Stay on Blacksmith. The gate's bottleneck is not the runner, and Depot does not address it.**

Three measurements decide this.

**Depot's main advantage does not apply to us.** Depot's differentiator is distributed Docker
layer caching, and it is genuinely best-in-class at it. We barely build Docker images in CI. The
`Build production Docker images` step is conditional on changes to the Dockerfiles, the lockfile,
or `packages/file-extract`; across the 40 most recent gate runs it took 0s in 38 and 1s in 2.
Production images are built by Render from `render.yaml`, not by GitHub Actions. Adopting Depot to
get its Docker cache would be buying the one thing our pipeline does not do.

**Raw CPU is a wash.** Independent 2026 benchmarks put the major providers within roughly a
percent of each other on CPU, which is smaller than run-to-run variance. Depot is not in the
public RunsOn dataset, so there is no credible number showing it beating Blacksmith on compute —
and no mechanism to expect one, since both rent similar hardware. Startup is already a non-issue
at a 13s median queue.

**We are already on the fast cache path.** Blacksmith transparently routes the standard
`actions/cache` actions to its own colocated cache, so no workflow change is needed to benefit,
and their `useblacksmith/cache` fork is deprecated in favour of the upstream actions we already
use. The repository's GitHub-side cache holds only CodeQL entries; every `verify-*` entry is
served by Blacksmith. Switching vendors would move this cache, not speed it up.

Depot also costs more per minute than Blacksmith for the Linux x64 runners we use. Paying a
premium for a Docker cache we do not use, to fix a bottleneck that is not the runner, is the wrong
trade.

## What the measurement actually found

The interesting result was not about vendors. In the `Build` job, restoring the cache costs more
than the work it exists to skip:

- restoring the build cache: p50 94s, p90 262s
- the `Build packages` step it can skip: p50 73s, p90 107s
- restore took longer than the build in 27 of 40 runs, and more than twice as long in 17
- across those 40 runs, restore spent 5417s to avoid at most 2677s of build work

That comparison is an upper bound and it is unflattering: even a perfect cache hit every single
time could only ever save the build time, and the build time is less than the restore time. The
entry is large because it carries `.turbo` build artifacts — Next.js output among them — and a
big tarball is slow to fetch no matter whose cache it lives in.

So the `Build` job now restores only `~/.bun/install/cache`, which keeps `bun install` at the 1–3s
it already costs, and rebuilds its artifacts instead of fetching them. `Static` and `Test` keep
their Turbo caches: those artifacts are small and restore in about 16s, so they still pay for
themselves. `scripts/lib/workflow-security.test.mjs` pins the new shape so the artifact cache
cannot quietly return.

This is a vendor-independent fix. It would have been worth making on Depot too, and it is worth
more than the migration would have been.

## Revisit triggers

Reopen this decision if any of these become true:

- CI starts building Docker images on the hot path — for example if we stop delegating image
  builds to Render, or add image-based integration tests. That is the case Depot is built for.
- Queue time stops being negligible. A sustained p90 above roughly a minute is a runner-provider
  problem.
- We need runner sizes or architectures Blacksmith does not offer at a competitive price.

Absent one of those, a migration is churn: every `runs-on` in four workflows, a re-pinned cache
story, and a new vendor in the trust boundary described in [CI security](../ci-security.md), in
exchange for no measured latency win.
