# Subagents

A subagent is a nested agent loop the opencompany chat engine can delegate one piece of work to. It
runs in its own context window, works the task with a read-only slice of the parent's tools, and
returns a single written summary. The intermediate tool results — the forty search hits, the raw
integration payload, the wiki sweep — stay in the child's context and never enter the parent's.

Gated by `RUNNER_OPENCOMPANY_SUBAGENTS_ENABLED` (default `false`). Codex and Claude Code sessions
have their own engine-native subagents and are unaffected by this flag.

Interactive chat only. Background task turns do not get the tool: a task is already the product's
"go do deeper work" primitive and runs with raised tool budgets, so nesting a second delegation
layer inside one multiplies cost where nobody is watching it happen. Revisit once interactive usage
shows what delegation actually costs.

## What the model sees

One tool, `run_subagent`, taking a short `description` for the UI and a self-contained `task`. The
model issues independent pieces of work as separate calls in the same step so they run concurrently.

A subagent starts fresh: it cannot see the conversation, cannot ask a follow-up question, and gets
nothing but the task text. Its summary is the only thing that crosses back.

## Tool inheritance

Inheritance is default-deny, listed in `SUBAGENT_INHERITED_TOOL_NAMES` and
`SUBAGENT_WITHHELD_TOOL_NAMES` in `packages/agent/src/subagent.ts`. A subagent gets the read-only
tools — Brain read, Wiki read, web search and fetch, Skills, and integration actions — and nothing
that writes, publishes, schedules, or spawns durable work.

Two consequences are worth stating plainly:

- **Wiki access is read-only.** The child's tool context is built with `wikiToolReadOnly`, so its
  schema only accepts read commands.
- **Only auto-approved actions are available.** An approval request raised inside a nested run has
  no surface to appear on — the user would never see it and the run would block. The subagent's
  action catalog is filtered to `permissionMode: "on"`, and naming an `ask` action directly is
  refused with `not_permitted` rather than reaching the parent dispatcher. When delegated work turns
  out to need a write or an approval, the subagent reports what should happen and the main agent
  does it.

`subagent.test.ts` fails when a new chat tool appears in neither list, so a subagent's access to a
new tool is always an explicit decision.

## Limits

Calibrated against what shipping harnesses allow, so delegation is not artificially worse here than
in Claude Code, Codex, or pi.

| Limit | Value | Notes |
| --- | --- | --- |
| Runs per turn | 16 | Shared across the whole tree, including nested runs |
| Concurrent runs | 8 | Further runs queue rather than fail |
| Steps per subagent | 24 | Larger than the parent's `CHAT_MAX_STEPS`; depth is the point of delegating |
| Nesting depth | 2 | A subagent may spawn one more level |
| Summary size | 50,000 characters | Truncated with a note telling the model to delegate something narrower |

The shared per-turn run budget is the binding limit: it bounds the whole tree no matter how the
model fans out or nests.

## Live trace

Each finished subagent step is projected into the parent's assistant message as `children` of the
subagent's tool part, which the existing `SubagentRow` renders as a collapsible nested trace — the
same nesting used for Claude Code and Codex subagents. Child tool inputs and outputs are stored as
truncated previews, and a run contributes at most 200 trace rows, so a long subagent cannot bloat the
persisted message.

Because the parent's model stream is parked on the tool call while the subagent runs, the trace
channel writes children into the projection and schedules its own throttled flush rather than
waiting for the next stream event. That is what makes the trace live instead of appearing all at
once when the subagent returns.

The trace is display-only. On replay, `convertToModelMessages` sees the tool part's `output` — the
summary — and never the children, which is what keeps the context isolation real rather than
cosmetic.

## Cost and billing

Subagent usage is recorded against the turn through `recordStepUsage` on a descending step index
starting at `-1000`, so it bills correctly without colliding with a main step's
subscription-covered idempotency key and without becoming the "latest step" that drives the chat
header's context meter.

A turn that delegates costs materially more than one that does not. That is the tradeoff the flag
exists to control.

## Failure behavior

A subagent that fails returns `{ ok: false, error }` to the main agent rather than failing the turn:
the main agent can work around a missing summary, but not around the turn dying underneath it. An
interrupted turn is the exception — the abort is rethrown so the parent stream tears down instead of
generating against a dead lease.
