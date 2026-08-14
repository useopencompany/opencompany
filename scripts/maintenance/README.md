# One-off maintenance tools

This directory is for retained, manually invoked diagnostics or data tools that are not part of
normal setup, CI, migrations, or releases. Every tool needs an ownership area, prerequisites, write
behavior, and an explicit safety note here.

## Retained tools

| Tool | Owner | Behavior and safety |
| --- | --- | --- |
| `measure-headless-chat-presentation.ts` | Chat/runtime maintainers | Publishes generated, short-lived presentation samples to `REDIS_URL`; it does not touch Postgres. Use a disposable or development Redis, never production. Run through `bun run measure:chat-presentation`. |

## Caller audit (2026-08-14)

- The retained presentation measurement still has an explicit root package command and current API,
  runner, core, and protocol imports, so it moved here with that caller updated.
- The Brain-to-Wiki migration executable and its planner export/tests had no application or
  automation caller; the executable also referenced a removed database entry point. They were
  deleted as completed migration tooling.
- The Workflow/Skill backfill and destructive cleanup scripts called only each other through usage
  comments and had no package, CI, release, or runtime caller. They were deleted as completed
  migration tooling.

Before adding a tool here, prefer a migration for durable schema/data transitions and a normal test
or supported script for repeatable verification.
