# H8 — Replace the SSE keep-alive busy-wait with event-driven close

**Severity:** 🟠 High (cheap to fix; scales poorly as-is).

> **Refactor, don't duct-tape.** Don't just shorten the sleep interval. Remove the
> polling loop entirely and drive the handler lifecycle off the connection's
> actual close event.

## Root cause

The SSE handler holds itself open with a 250ms spin loop
(`apps/runner/src/server.ts:201-203`):

```ts
while (!closed) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
```

`closed` is flipped by the `request.raw.on("close", ...)` listener that's already
registered (`server.ts:174-176`). So the loop is pure overhead: it delays close
detection up to 250ms and burns a timer per open connection. Each connection also
arms its own `setInterval` heartbeat (`server.ts:197-199`).

## The refactor

1. Replace the loop with a single promise that resolves when the connection
   closes — resolve it directly from the existing `request.raw.on("close")`
   handler. `await` that promise instead of spinning.
2. Do all teardown (clear heartbeat interval, `unsubscribe`, log close) in one
   place after the promise resolves. Ensure teardown also runs if the server is
   shutting down (tie into `server.close()` / a shutdown signal so open streams
   end cleanly).
3. Keep the heartbeat (`: heartbeat\n\n`) — it's correct for proxies — but verify
   it's cleared on every exit path.

## Files in scope

- `apps/runner/src/server.ts` (SSE handler body)

## Acceptance criteria

- No `setTimeout` polling loop in the SSE handler; close is detected immediately
  via the close event.
- Heartbeat and subscription are always torn down (no leaked intervals /
  listeners) on client disconnect and on server shutdown.
- Existing SSE tests pass; add one asserting teardown runs exactly once on close.

## Risks / notes

- Make sure `reply.hijack()` + manual `raw` writes still interact correctly with
  Fastify lifecycle when the handler returns via the promise rather than the
  loop.
