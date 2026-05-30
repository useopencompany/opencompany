# H6 — Make lease-guarded writes atomic (kill the TOCTOU)

**Severity:** 🟠 High — correctness (stale runner can write) + 2× round-trips per event.

> **Refactor, don't duct-tape.** Do not paper over the race by adding more
> `isRunLeaseCurrent` checks or retry loops. Collapse the check and the write into
> a single conditional statement so the lease guard is *enforced by the database*,
> not advisory.

## Root cause

The session-execution lease is checked and then written in two separate
statements. `appendRuntimeEventForLease` (`apps/runner/src/lease-writes.ts:184-191`):

```ts
if (!(await isRunLeaseCurrent(input.sessionId, leaseId, leaseOwner))) return false; // SELECT
await appendRuntimeEvent(getDb(), event);                                           // INSERT
```

The same `requireLeaseWrite(isRunLeaseCurrent(...))`-then-write shape repeats in
`createAssistantMessageForLease`, `completeAssistantMessageForLease`,
`insertToolMessageForLease` (`lease-writes.ts`), and in `recordStepUsage` /
`recordToolUsage` (`usage-recorder.ts:27-29,130-132`).

Two problems:

- **TOCTOU / not enforced:** between the `SELECT` and the `INSERT` the lease can
  be lost or reclaimed by another instance, and the write still lands. The guard
  is advisory. This is exactly the kind of thing that lets a "stale runner stomp
  on a session reclaimed elsewhere" — which the comment at the top of
  `lease-writes.ts` claims to prevent but doesn't, atomically.
- **2 round-trips per event:** and there are many durable events per turn
  (message.created, reasoning start/stop, tool.started, file.changed,
  tool.completed, session.usage, message.completed…). Over `neon-http` (C1)
  that's a lot of HTTP.

The reason it's written this way is that `neon-http` has no interactive
transactions — so C1 is a prerequisite for the cleanest form.

## The refactor

1. Express each lease-guarded write as a **single conditional statement** that
   only writes if the lease is still current. Two acceptable shapes:
   - A CTE / `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM agent_sessions WHERE
     id = … AND run_lease_id = … AND run_lease_owner = … AND archived_at IS NULL)`
     that `RETURNING`s the row; zero rows ⇒ lease lost ⇒ throw `StaleRunLeaseError`.
   - Or wrap the read + write in a real `db.transaction()` with the lease row
     locked `FOR UPDATE` (available after C1).
2. Apply consistently across all `*ForLease` helpers and the usage recorders so
   the pattern is uniform and there is exactly one round-trip per guarded write.
3. Keep `requireLeaseWrite` semantics (throw on no-write) but have it interpret
   "zero rows affected" from the atomic statement instead of a separate boolean
   probe.

## Files in scope

- `apps/runner/src/lease-writes.ts` (all `*ForLease` helpers,
  `appendRuntimeEventForLease`, `isRunLeaseCurrent` usage)
- `apps/runner/src/usage-recorder.ts` (lease guard + insert + ledger in one txn —
  coordinate with H5)
- `apps/runner/src/events.ts` (`appendRuntimeEvent` may need a lease-aware variant)

## Acceptance criteria

- Each lease-guarded write is a single statement/transaction; no separate
  pre-`SELECT`.
- A concurrent lease reclaim between "check" and "write" can no longer produce a
  write under the old lease (test: reclaim the lease on another owner, then
  attempt a guarded write under the old lease and assert it is rejected).
- Durable-event round-trip count per turn is roughly halved.

## Risks / notes

- Depends on C1 for the transactional form; the CTE form can land first if
  needed, but prefer the transactional version once pooling is in.
- Be careful that "zero rows affected" is distinguishable from "row already in
  desired state" for the idempotent inserts (e.g. assistant message
  `onConflictDoNothing`). Preserve existing idempotency semantics.
