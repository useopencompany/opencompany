# M12 — Stop re-loading the full message history every turn

**Severity:** 🟡 Medium — per-turn cost grows unbounded with session length.

> **Refactor, don't duct-tape.** Don't just slap a `LIMIT` on the message load —
> that silently drops context the model needs. Introduce an intentional
> context-window / summarization strategy and a single source of truth for the
> per-turn message load.

## Root cause

Each turn loads the entire message history, unbounded:

- `runMessageWithContext` selects **all** messages for the session
  (`apps/runner/src/agent-loop.ts:333-339`) to build the model transcript via
  `buildModelMessages`. The after-session path does the same
  (`agent-loop.ts:841-851`).
- `loadSession` (`apps/runner/src/session-lifecycle.ts:144-171`) does a 4-table
  join plus a separate repository query on every run.

For long sessions this is a growing per-turn DB cost and an ever-larger prompt,
with no windowing, truncation, or summarization policy.

## The refactor

1. Define an explicit **context policy**: how many recent turns/tokens are
   replayed, when older history is summarized/compacted, and how brain/durable
   context substitutes for raw transcript. Encode it in one place so both the
   message path and after-session path share it.
2. Replace the unbounded `select all messages` with a windowed/cursor query that
   honors the policy, while preserving the existing invariant that only user +
   assistant messages are replayed into the model (tool messages excluded — see
   `docs/runner.md` "Model and tool loop").
3. Consider caching the static parts of `loadSession` (agent config, workspace,
   repository) for the duration of a turn instead of re-querying.

## Files in scope

- `apps/runner/src/agent-loop.ts` (message load in `runMessageWithContext` and
  the after-session path)
- `apps/runner/src/model-messages.ts` (`buildModelMessages`)
- `apps/runner/src/session-lifecycle.ts` (`loadSession`)
- `docs/runner.md` / `docs/agent-turn-vocabulary.md` (document the policy)

## Acceptance criteria

- Per-turn message load is bounded by the context policy, not by total session
  length, **without** silently losing context the model relies on (policy is
  explicit and documented).
- The tool-message exclusion invariant is preserved (no orphan tool results in
  the transcript — the Gateway error described in `docs/runner.md` must not
  reappear).
- Long-session turn latency no longer scales linearly with message count.

## Risks / notes

- This touches prompt construction; regressions here change model behavior.
  Snapshot the built `ModelMessage[]` for representative sessions before/after.
- Coordinate with M10 (client also derives from full history) so the product's
  notion of "what's in context" is consistent across runner and UI.
