# Database state invariants

## Context

Many finite state fields are still plain `text` columns in `packages/db/src/schema.ts`. Examples include workspace membership role, GitHub sync statuses, Brain sync operation/status, agent session status, message role/status, after-session status, checkout status, ledger source, integration provider/resource type, and artifact kind.

Relevant code:

- `packages/db/src/schema.ts`
- `drizzle/`
- `apps/web/lib/**`
- `apps/runner/src/**`

## Problem

Application types and conventions currently carry invariants that the database does not enforce. As production data accumulates, typos and impossible states become expensive to clean up and hard to reason about.

## Goal

Enforce core finite states at the database boundary.

## Suggested approach

Use Drizzle `pgEnum` or check constraints for the most important state fields first:

- `workspace_memberships.role`
- `agents.github_sync_status`
- `agent_sync_jobs.status`
- `brain_files.github_sync_status`
- `brain_sync_jobs.operation`
- `brain_sync_jobs.status`
- `agent_sessions.status`
- `agent_session_messages.role`
- `agent_session_messages.status`
- `agent_session_after_session_runs.status`
- `stripe_checkout_sessions.status`
- `workspace_credit_ledger.source`
- `workspace_integrations.provider`
- `workspace_integration_resources.provider`
- `workspace_integration_resources.resource_type`
- `agent_session_artifacts.kind`

Export matching TypeScript unions from a shared package or from `packages/db`, and update code to consume those constants instead of repeating string literals.

## Acceptance criteria

- Schema has DB-level constraints or enums for the core finite state fields.
- Existing code compiles against shared constants or exported union types.
- A Drizzle migration is checked in.
- Tests cover at least one rejected invalid state at the schema/helper layer where practical.

## Verification

Run:

```sh
bun run db:generate
bun run typecheck
bun run test
```
