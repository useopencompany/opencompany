# H4 — Make reconnect actually recover durable state

**Severity:** 🟠 High — live correctness bug on long sessions.

> **Refactor, don't duct-tape.** Do not just bump the `300` limit to a bigger
> number. That moves the cliff, it doesn't remove it. Fix the reconnect contract:
> the stream must be able to deliver every durable event the client missed, and
> the detail fetch must return a correct window, not "the oldest N".

## Root cause

Two compounding defects in the reconnect path:

1. **The SSE stream never replays.** `apps/runner/src/server.ts:171,224-228`
   reads `Last-Event-ID` / `after` into `requestedAfterId` and tracks
   `latestDurableEventId`, but the handler only subscribes to *live* events going
   forward (`subscribeSessionEvents`). `listSessionEvents()` exists
   (`apps/runner/src/events.ts:72`) and is purpose-built for replay, but the SSE
   path never calls it. The design instead relies entirely on the client
   refetching session detail on `onOpen`.

2. **The refetch returns the wrong window.** `apps/web/lib/agent-sessions/data.ts:149-154`
   loads events with `.orderBy(asc(id)).limit(300)` — i.e. events **1–300**. Once
   a session exceeds 300 durable events, the most recent ones are silently
   dropped. (Messages, by contrast, are loaded unbounded at `data.ts:144-148` —
   inconsistent.)

Combined: on a long session, a refresh/reconnect can permanently lose visibility
of recent completed tool calls and message boundaries, with no live replay to
recover them.

## The refactor

Make the contract explicit and correct. Pick one coherent model (preferably both
halves):

1. **Server-side replay on connect.** On SSE connect, before/while attaching the
   live subscription, replay durable events with `id > after` from
   `listSessionEvents` in id order, then switch to live. Guarantee no gap and no
   dup across the handoff (the client already dedupes by id via
   `processedEventIds`, so a small overlap is safe). Honor `Last-Event-ID` so the
   browser's native `EventSource` reconnect "just works".
   - The client currently does **not** send `after` on reconnect
     (`useSessionEventStream.ts:89-92` sets only `token`). Either rely on the
     native `Last-Event-ID` header (server already reads it) or pass `after`
     explicitly from the highest known durable id.

2. **Correct the detail window.** Change the event load in `data.ts` to a bounded
   query that returns a *correct* slice for first paint (e.g. the latest N with
   proper pagination, or cursor-based), and lean on stream replay (#1) for the
   rest. Make event and message bounding consistent and intentional.

3. Add a regression test that drives a session past 300 events, disconnects, and
   reconnects, asserting the client converges to the full durable state.

## Files in scope

- `apps/runner/src/server.ts` (SSE replay on connect)
- `apps/runner/src/events.ts` (`listSessionEvents` — paging if needed)
- `apps/web/components/useSessionEventStream.ts` (send `after` / rely on
  `Last-Event-ID`)
- `apps/web/lib/agent-sessions/data.ts` (correct event window)
- `docs/runner.md` ("Event model" — document the replay contract precisely)

## Acceptance criteria

- A session with >300 durable events, after disconnect/reconnect, shows complete
  and correct state (no missing tool calls / message boundaries).
- No duplicated events rendered; transient deltas behave as before.
- The reconnect contract is documented and tested.

## Risks / notes

- Watch replay volume on very long sessions; page the replay and stream it rather
  than buffering everything in memory.
- Coordinate ordering with C3 (shared transport): replay-then-live handoff must
  be race-free when events can arrive from another instance.
