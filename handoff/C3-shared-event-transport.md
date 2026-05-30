# C3 — Replace the in-process event bus with a shared transport

**Severity:** 🔴 Critical — hard ceiling of one runner instance for live streaming.

> **Refactor, don't duct-tape.** Do not "solve" this with sticky sessions /
> session-affinity routing at the load balancer as the permanent answer — that
> couples the browser's connection to the runner that happened to claim the job,
> which the queue explicitly decouples, and it breaks again the moment a job is
> reclaimed by another instance mid-run. Introduce a real cross-instance event
> transport so any SSE connection on any instance can serve any session.

## Root cause

`apps/runner/src/events.ts:24` — the session event broker is a process-local
`EventEmitter`:

```ts
const sessionEventBroker = new EventEmitter();
```

`publishRuntimeEvent` emits on `session:<id>`, and the SSE handler subscribes via
`subscribeSessionEvents` (`apps/runner/src/server.ts:194`). But SSE connections
and job execution are routed independently:

- The browser opens `EventSource` against `RUNNER_PUBLIC_URL` → whichever
  instance the load balancer picks.
- The run executes on whichever instance claimed the job from
  `agent_session_run_jobs` (`jobs.ts`).

On one instance this is fine. With two instances, a user can connect to A while
their run executes on B and **see no live stream at all** — only the post-hoc
refetch. This is the real horizontal-scale blocker (more so than leases, which
are already in Postgres).

## The refactor

1. Introduce a transport abstraction `SessionEventBus` with `publish(sessionId,
   event)` and `subscribe(sessionId, listener): unsubscribe`. Keep
   `appendRuntimeEvent` / `publishTransientRuntimeEvent` call sites unchanged —
   they call the bus.
2. Implement it on a **shared** transport. Preferred: **Postgres
   `LISTEN/NOTIFY`** (you are already all-in on Postgres, no new infra):
   - Each instance holds one dedicated `LISTEN` connection (needs the pooled/raw
     connection from C1 — `NOTIFY`/`LISTEN` needs a session, so use a dedicated
     non-pooled connection or a direct connection, **not** the transaction
     pooler).
   - `publish` does `NOTIFY <channel>, <payload>` (or writes to a small relay
     table + `NOTIFY` if payloads exceed the 8KB `NOTIFY` limit — transient
     deltas can be large, so design for the size limit explicitly).
   - SSE handler subscribes through the bus; the LISTEN connection fans out to
     local subscribers by `sessionId`.
   - Alternative: Redis pub/sub if you'd rather not put delta volume on Postgres.
     Make this an explicit, documented decision.
3. Keep the local `EventEmitter` as an **in-process fast path** layered under the
   bus (publish locally AND to the shared transport; dedupe on the SSE side by
   event id, which the client already does via `processedEventIds`). This avoids
   a network hop when the SSE and the run happen to be co-located.
4. Mind payload size and volume: transient `message.delta` / `command.output`
   are high-frequency. If using Postgres NOTIFY, confirm the 8000-byte payload
   ceiling and chunk or relay accordingly; if using Redis, confirm it's sized for
   the delta firehose.

## Files in scope

- `apps/runner/src/events.ts` (bus abstraction + shared transport impl)
- `apps/runner/src/server.ts` (SSE subscribe path)
- `apps/runner/src/index.ts` (own/drain the LISTEN connection lifecycle)
- `docs/runner.md` ("Event model" + "Hosting" sections — currently describes a
  single long-lived process; update for multi-instance)

## Acceptance criteria

- With two runner instances behind a load balancer, a session whose job runs on
  instance B streams live to a browser connected to instance A.
- Transient deltas (text, reasoning, command output) and durable events both fan
  out cross-instance.
- No event duplication visible to the client (id-dedupe holds); transient/no-id
  events tolerated as today.
- Documented sizing/limits for the chosen transport.

## Risks / notes

- Postgres `LISTEN/NOTIFY` requires a session connection — it will **not** work
  through the PgBouncer transaction pooler. Provision a dedicated direct
  connection for it (coordinate with C1's connection budget).
- This pairs naturally with H7 (NOTIFY-based worker wakeup) — same connection
  machinery; do them together.
