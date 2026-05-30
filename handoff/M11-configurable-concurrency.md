# M11 — Make worker concurrency configurable (and right-sized)

**Severity:** 🟡 Medium — a single runner caps at 2 concurrent sessions.

> **Refactor, don't duct-tape.** Don't just bump the constant to a bigger magic
> number. Make concurrency an explicit, env-driven capacity decision tied to the
> instance's resources and the DB connection budget.

## Root cause

`apps/runner/src/jobs.ts:23` hardcodes `DEFAULT_WORKER_CONCURRENCY = 2`, and
`startRunnerJobWorker` is invoked with no override in
`apps/runner/src/index.ts:16`. So one runner instance executes at most 2 sessions
concurrently regardless of CPU/RAM headroom, and there's no way to tune it in
production without a code change.

## The refactor

1. Add a typed env var (e.g. `RUNNER_WORKER_CONCURRENCY`) parsed in
   `apps/runner/src/env.ts` (`RunnerEnv`), defaulting sensibly, and pass it into
   `startRunnerJobWorker` from `index.ts`.
2. Tie the default/ceiling to real capacity: the DB connection pool size from C1
   (`concurrency × queries-in-flight` must fit the pool), E2B sandbox limits, and
   memory. Document the relationship in `docs/runner.md` and `render.yaml`.
3. Surface the effective concurrency in startup logs / `/healthz` so it's
   observable in prod.

## Files in scope

- `apps/runner/src/env.ts` (`loadEnv`, `RunnerEnv`)
- `apps/runner/src/index.ts` (pass through)
- `apps/runner/src/jobs.ts` (already accepts `concurrency`)
- `docs/runner.md`, `render.yaml`, `.env.example`

## Acceptance criteria

- Concurrency is set via env, with a documented default and its relationship to
  pool size / sandbox limits.
- Effective value is logged at startup.
- No regression to claim/lease safety at higher concurrency.

## Risks / notes

- Don't set concurrency higher than the DB pool can serve (coordinate with C1) or
  you'll trade queue latency for connection-wait latency.
