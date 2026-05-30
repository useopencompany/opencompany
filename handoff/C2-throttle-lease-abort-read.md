# C2 — Stop doing a DB read on every stream token

**Severity:** 🔴 Critical — primary latency sink in the streaming hot path.

> **Refactor, don't duct-tape.** The goal is a coherent run-control model where
> liveness/abort checks are decoupled from token cadence. Do not "just add a
> counter so we only check every N parts" as a one-liner bolt-on without
> rethinking where abort signals actually come from. Build the right cadence
> primitive and route all hot-path checks through it.

## Root cause

`collectAssistantStream` calls `await input.checkAbort()` on **every** stream
part (`apps/runner/src/model-stream-runner.ts:106`). `checkAbort` is
`createLeaseAbortCheck` (`apps/runner/src/agent-loop.ts:1112-1123`), which calls:

- `maybeHeartbeatRunLease(...)` — already throttled to `RUN_HEARTBEAT_INTERVAL_MS`
  (5s). Good.
- `checkRunControl(...)` — **not throttled**. It calls
  `store.loadState(sessionId)` (`apps/runner/src/run-control.ts:208-214`), a
  `SELECT` against `agent_sessions`, on every invocation.

So a fast model emitting hundreds of text-deltas triggers hundreds of `SELECT`s
per turn. Over the `neon-http` driver (see C1) each is a separate HTTPS request.
The same per-part `checkAbort` also runs inside tool command output callbacks
(`tool-dispatcher.ts:313, 343`).

## The refactor

1. Separate the two concerns the hot path actually needs:
   - **Local abort** (user clicked stop / lease lost locally / external signal):
     this is already represented by `ctx.controller` / `AbortSignal` and is
     *free* to check synchronously. Check it on every part.
   - **Remote state reconciliation** (abort requested on another path, lease
     reclaimed, session archived): this is the only thing that needs a DB read.
     It does **not** need per-token freshness.
2. Throttle the DB-backed run-control read to a wall-clock interval (reuse the
   `RUN_HEARTBEAT_INTERVAL_MS` cadence, or a dedicated interval), and additionally
   force a check at natural boundaries (each `finish-step`, before each tool
   execution, before persisting completion).
3. Fold the lease heartbeat and the run-control read into a **single** periodic
   DB touch where possible — you already write a heartbeat every 5s; piggyback
   the `abortRequestedAt` / lease-ownership read on that same statement (one
   round-trip instead of two).
4. Make the per-part check synchronous and allocation-free for the common case
   (no `await`, no DB) so it doesn't add overhead to token throughput.

## Files in scope

- `apps/runner/src/run-control.ts` (`checkRunControl`, `maybeHeartbeatRunLease` —
  consider merging into one heartbeat-and-read primitive)
- `apps/runner/src/agent-loop.ts` (`createLeaseAbortCheck`)
- `apps/runner/src/model-stream-runner.ts` (per-part check call site)
- `apps/runner/src/tool-dispatcher.ts` (command-output `checkAbort` calls)

## Acceptance criteria

- A streaming turn of N text-deltas performs O(turn-duration / interval) DB
  run-control reads, **not** O(N).
- Local abort (stop button, lease lost via heartbeat) still aborts within one
  stream part — no regression in abort responsiveness for the common case.
- Remote abort / lease reclaim / archive is still honored within the throttle
  interval (add a test that flips `abortRequestedAt` mid-stream and asserts the
  run stops within the interval).
- Capture before/after DB-read counts for a representative turn in the PR.

## Risks / notes

- Don't widen the abort-detection window so far that "stop" feels laggy. The
  local `AbortController` path must remain instantaneous; only the DB read is
  throttled.
- Coordinate with C1: once transactions/pooling land, the single heartbeat-and-
  read statement is cheaper and cleaner.
