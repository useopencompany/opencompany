# Agent turn vocabulary

How the agent loop supports more than `user → assistant → done`: intermediate
assistant utterances, live-streamed text, and **mid-run user steering**. This
document records the design decisions behind the loop, especially steering,
because that is the part most likely to be implemented incorrectly if rushed.

## Background

The loop today is one `streamText` call per user message (`runMessage` in
`apps/runner/src/agent-loop.ts`). The AI SDK runs an internal multi-step loop
(model → tool calls → tool results → model …, capped at `MAX_MODEL_STEPS`) and
the runner persists one assistant message per turn at the end.

Two capabilities make the loop feel richer:

1. **Intermediate assistant utterances** — e.g. the opening "mode announcement"
   before tool calls. These need no new loop machinery: `streamText` already
   interleaves text and tool calls across steps, and assistant text is now
   streamed to the UI as live immediate transient `message.delta` events (see
   `apps/runner/src/model-stream-runner.ts`). The client interleaves live text
   with tool cards in event order (`buildEventAssistantTurnParts`) while the
   final assistant message remains the durable transcript.
2. **Mid-run user steering** — the user adds or redirects work while a run is
   in flight ("also include competitor W", "skip Z"), without starting a
   disconnected session.

## Open questions and decisions

### How do interrupts work mechanically? Cancel in-flight tool calls, or queue?

**Decision: queue and apply at the next model-step boundary. Do not cancel
in-flight tool calls.** Cancelling a tool mid-execution wastes work the user is
about to see and complicates partial-result persistence. Instead, a pending
steer halts the run at the next step boundary via an async `stopWhen` condition.
`stopWhen` is evaluated *after* a step completes (including its tool results),
so the current step's tool calls always finish and are persisted before the run
stops.

This is distinct from **abort** (`abortRequestedAt` / the stop button), which
*does* cancel immediately. Steering is additive; abort is destructive.

### Does a mid-run steer count as a turn for context/history?

**Decision: yes.** A steer is a real, non-internal `user` message. It is part of
history and is replayed into model context like any other user message. This
keeps the transcript honest and lets the model see exactly what it was told.

### How does steering compose with pending tool calls?

The in-flight turn finishes its current step (tool calls included), persists its
assistant message, and releases its lease. The steer is then answered as the
**next turn**, which rebuilds full model context from the database — including
the just-completed assistant output, its tool results, and the steer message.
The model continues with everything in view.

## Mechanism

Steering reuses the existing per-turn machinery rather than restructuring it, so
the lease, assistant-message idempotency (`responseToMessageId`), sandbox
lifecycle, brain sync, usage, and abort paths are unchanged.

1. **Stop condition.** Each turn's `streamText` gets an extra async `stopWhen`
   condition that returns true when an unanswered, non-internal `user` message
   exists that was created after the message this turn is answering
   (`loadNextSteerMessage`). When true, the run stops at the next step boundary.
2. **Per-turn loop.** `runMessage` wraps `runMessageTurn` in a loop. A turn runs
   the full existing path (acquire lease → stream → sync brain → persist →
   release lease). After it completes, it computes the next unanswered steer
   message; if present, the loop runs another turn answering it. Each turn
   acquires its own fresh lease and creates its own assistant message keyed by
   `responseToMessageId`, so idempotency is exactly today's.
3. **Why re-dispatch in-process.** A steer submitted while the lease is busy is
   rejected by `acquireRunLease` (`skipped_lease_busy`) and the web layer does
   not retry it. The in-process loop is what answers it once the lease frees.
   Double-answers are prevented by the existing guards: only one writer wins
   `createAssistantMessageForLease` (unique `responseToMessageId`), and
   `loadAssistantResponseForMessage` short-circuits an already-answered message.

## Blocking mid-run clarifications

The supported v1 is: the model asks a clarifying question as streamed text and
ends its turn. The user's reply is the next turn and the loop continues with full
context. This needs no extra mechanism.

A **true block that pauses with tool calls still pending** (the model asks, the
run parks mid-step, and resumes the exact in-flight tool plan on reply) is
deliberately **out of scope here**. It requires parking and rehydrating an
in-flight `streamText` step plan, which is materially riskier than the
queue-at-boundary model above and is not needed for the announcement/steering
use cases. Revisit only with a concrete product need.

## Known limitations / follow-ups

- **End-of-run race.** If a steer lands in the brief window after the loop's
  final steer check and after the lease is released, it can remain unanswered
  (the same outcome as today). A durable fix is to re-dispatch unanswered user
  messages from the job layer on lease release; tracked as a follow-up.
- **Mid-run job retry.** If the runner job is redelivered after some turns
  completed, the top-level duplicate guard keys on the original message, so a
  queued steer may not be re-picked. Same durable-dispatch follow-up applies.
