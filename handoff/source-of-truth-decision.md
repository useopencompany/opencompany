# Workspace state source-of-truth decision

## Context

The docs still conflict on the product model. `README.md` says GitHub is the source of truth for workspace state, while `docs/architecture.md` says Neon Postgres is the immediate app source of truth and notes there is no GitHub webhook ingestion path.

Relevant docs and code:

- `README.md`
- `docs/architecture.md`
- `docs/agent-file.md`
- `docs/stack/data-and-state.md`
- `apps/web/lib/workspace-state/github.ts`
- `apps/web/lib/agents/actions.ts`
- `apps/web/lib/brain/actions.ts`

## Problem

The implementation behaves like Postgres is canonical and GitHub is async materialization/versioning. The product wording says GitHub is canonical. This ambiguity will cause bad architecture decisions around imports, conflict handling, sync status, and future webhooks.

## Goal

Make the source-of-truth model explicit and align docs, UI language, and sync architecture.

## Suggested approach

Choose one of these models:

1. Postgres canonical for app state, GitHub as versioned materialization.
2. GitHub canonical for `.agent` and Brain files, with webhook ingestion and conflict resolution.

Given current code, option 1 is lower risk for MVP. If choosing option 1:

- Update README and architecture docs to say Postgres is the interactive source of truth.
- Describe GitHub as durable versioned backing storage and integration surface.
- Keep manual GitHub import as a reconciliation tool, not the normal authority path.
- Pair this with the sync sweeper handoff so materialization is reliable.

If choosing option 2:

- Add GitHub webhook ingestion.
- Define conflict semantics between editor saves and external GitHub edits.
- Stop treating app saves as fully authoritative until GitHub confirms or reconcile conflicts.

## Acceptance criteria

- README, architecture docs, and agent-file docs use one consistent source-of-truth model.
- Code comments and sync status copy do not imply the opposite model.
- Any remaining limitations are documented as explicit product tradeoffs, not contradictions.

## Verification

Run:

```sh
bun run format:check
```
