# M10 — Fix the O(n)-per-event client reducer

**Severity:** 🟡 Medium — UI degrades on long, tool-heavy sessions.

> **Refactor, don't duct-tape.** Don't cap the number of rendered events to hide
> the slowdown. Restructure the state so applying an event and deriving a
> message's view are not full scans of the entire event history.

## Root cause

`applyRuntimeEventToState` (`apps/web/lib/agent-sessions/runtime-events.ts:83-94`)
rebuilds the entire `events` array on every event:

```ts
let next = { ...state, events: [...state.events, event] };
```

and the derivation helpers re-scan **all** events for a message on every render:
`buildAssistantTurnParts`, `buildRuntimeToolCallsForMessage` (iterate the whole
`events` array), `isReasoningInProgress`, `computeThinkingDurationSeconds`, etc.
During a live stream this is O(n) per delta and O(n) per render, so a long
session with many tool calls visibly janks.

## The refactor

1. Restructure runtime state so per-message derivations don't scan the global
   event list:
   - Index events by `messageId` (and keep a flat ordered list only where truly
     needed).
   - Maintain derived per-message view state incrementally as events arrive,
     rather than recomputing from scratch each render.
2. Memoize the expensive derivations (`buildAssistantTurnParts` etc.) keyed by
   message id + a cheap version counter, so unchanged messages don't recompute.
3. Keep the reducer pure and id-deduped (the existing dedupe by `event.id` stays),
   but avoid the full-array spread on the hot transient path where possible.

## Files in scope

- `apps/web/lib/agent-sessions/runtime-events.ts` (state shape + derivations)
- `apps/web/components/SessionView.tsx` (consumes the derived state; memoization
  boundaries)

## Acceptance criteria

- Applying an event and rendering during a live stream is no longer O(total
  events) — demonstrate with a profiling note or a perf test over a synthetic
  long session (e.g. 5k events).
- Visual output is unchanged (snapshot/behavior tests for turn-part assembly
  still pass).

## Risks / notes

- The transient/durable ordering rules (`isEventAtLeastAsRecent`, null-id tie-
  breaking) are subtle — preserve them exactly when moving to indexed state.
