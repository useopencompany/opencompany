# Workflow authoring from chat (PRO-242)

For workspace admins, main chat exposes one `workflows` tool in native chat and the Codex/Claude MCP bridge.
Commands are `list`, `read`, `create`, `update`, `activate`, `pause`, `run`, `archive`, and
`clear_memory`. Definition fields live under `workflow`; identity, command and expected version
stay at the top level. The API adapter translates these into the existing workflow service.

V1 authors one step with a manual trigger or one schedule. It supports personal/company scope
and memory. Multiple steps, event/multiple triggers, model selection, and channel configuration
remain in the editor. Unrelated edits preserve these existing settings. No schema migration,
new persistence layer, or separate scheduler is introduced.

New workflows default to personal drafts. Recurring requests need complete timing before
creation. Explicit activation goes through the existing planner. Memory is configured before a
draft becomes active. Partial failures return the saved workflow and its actual state. Read
before editing and supply the current version; stale edits are rejected. Retried identical
creates within a turn recover the original workflow. Background tasks and subagents cannot
manage workflows. Workflow runs use the existing Task execution path and per-turn reservation.

## Contract comparison — 2026-09-17

Three scenarios cover scheduled creation with memory, clarification of incomplete timing, and
rename-only edits. Each ran four times on Kimi K2.6, Kimi K3, and Sonnet 5: 108 real gateway
trials with synthetic workflow execution. This is a small behavioral comparison, not a measured
production reliability rate.

| Inputs | Passed | Scenario/model groups with all four passing | Mean input/output tokens | Mean tool calls | Cost |
| --- | --- | --- | --- | --- | --- |
| Flat fields | 33/36 | 7/9 | 10,186 / 651 | 1.17 | $0.435948 |
| Grouped definition | 36/36 | 9/9 | 9,946 / 585 | 1.11 | $0.405054 |
| Describe-first | 35/36 | 8/9 | 12,494 / 689 | 1.81 | $0.503917 |

Selected grouped inputs. Flat inputs produced two drafts before asking for timing and one
rename that resubmitted untouched fields. Describe-first also created a draft before asking
and repeated discovery. No failing trial activated a workflow with invented timing.

A nine-trial follow-up through the final production parser passed 8/9. Kimi K3 again created a
safe draft before asking for timing. The prompt now explicitly asks before creating even a
draft when a recurring request lacks timing. The follow-up also corrected the creation fixture
to return the submitted definition instead of inheriting the sample workflow's schedule.

After that instruction change, all 12 clarification repeats (four per model) asked without
writing. The overall grader passed 11/12: one Kimi K3 trial unnecessarily tried a read-only
Linear lookup that the synthetic fixture disallows, then asked for clarification. This remaining
scope-discipline failure is recorded rather than treated as a pass. Total known gateway cost
including setup/smoke runs and both follow-ups was $1.744662, below the approved $5 threshold.

## Verification and limits

Focused tests cover canonical service authorization, defaults, partial failures, optimistic
versions, retry identity, settings preservation, memory before activation, pausing, API actor
reauthorization, native/MCP exposure, and task/result card rendering. Local isolated-database
checks exercised create, read, replay, rename, stale-version rejection, failed activation, and
pause. The test schedule was paused afterward.

The screenshots in `docs/screenshots/pro-242-*.png` show the production React card with actual
local API results and the app's CSS, rendered in an isolated browser preview. They are not full
chat-page screenshots. Full-route browser verification was blocked by existing Next.js client
bundling errors involving OpenTelemetry's `stream` dependency and the agent-runtime barrel's
`node:crypto` import. Component integration tests cover the chat renderer. CI remains required
before merge.
