# H7 — Remove the ~1s poll latency before a turn starts

**Severity:** 🟠 High — directly contradicts the "super fast latency" goal.

> **Refactor, don't duct-tape.** Do not just drop the poll interval to 100ms to
> "feel faster" — that hammers the DB and still adds latency. Introduce an
> event-driven wakeup; keep polling only as a crash-recovery backstop.

## Root cause

The internal endpoints enqueue a job and return `202` immediately
(`apps/runner/src/server.ts:44-105`). The job worker then **polls** the queue on
a fixed interval (`apps/runner/src/jobs.ts:24`,
`DEFAULT_WORKER_POLL_INTERVAL_MS = 1_000`; loop at `jobs.ts:349-385`).

So a user message incurs: web → runner HTTP (enqueue) → **up to ~1s** before the
worker claims it → lease acquire → model call. That's up to a second of dead time
on the first-token path before anything happens.

## The refactor

1. **Wake the worker on enqueue.** Two layers:
   - **Same instance:** signal the run loop in-process the moment a job is
     enqueued (e.g. resolve a "work available" promise / bump a condition the loop
     awaits) so it claims immediately instead of waiting for the next tick.
   - **Cross instance:** emit a Postgres `NOTIFY` on enqueue; every instance's
     worker `LISTEN`s and tries to claim on notification. (Reuse the
     `LISTEN/NOTIFY` machinery from C3 — same dedicated connection.)
2. Keep the periodic poll as a **backstop only** (for crashed-instance reclaim of
   `running` jobs whose lease expired, and missed notifications). It can be much
   slower than 1s once notify-driven pickup exists.
3. Preserve the existing claim semantics (`FOR UPDATE SKIP LOCKED`, idempotency,
   heartbeats) — only the *wakeup trigger* changes, not the claim safety.

## Files in scope

- `apps/runner/src/jobs.ts` (`startRunnerJobWorker` loop, `enqueueRunnerJob`)
- `apps/runner/src/server.ts` (enqueue endpoints — trigger the in-process signal)
- `apps/runner/src/index.ts` (own the LISTEN connection if cross-instance notify)
- `docs/runner.md` (request-flow latency description)

## Acceptance criteria

- Time from enqueue to job-claim is bounded by signal latency, not the poll
  interval (measure: enqueue→`running` transition well under ~50ms on a warm
  worker with free concurrency).
- Crash recovery still works: a job orphaned by a dead instance is reclaimed by
  another instance via the backstop poll / lease expiry.
- No busy-spin; the idle worker is genuinely idle between signals.

## Risks / notes

- Don't lose jobs enqueued in the window between "worker checked" and "started
  awaiting signal" — the in-process signal must be edge+level safe (check the
  queue once after arming the wait).
- This is best done together with C3 (shared transport) since both want a
  dedicated `LISTEN` connection.
