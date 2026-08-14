# opencompany app and runner map

This document describes the current product flow. The web app presents Chat, Tasks, Workflows,
Brain, Wiki, integrations, and settings; the canonical API owns public commands and read models;
the runner owns durable execution.

## Chat

```text
Surface
  typed POST /v1/messages
    authenticate Actor and workspace
    reserve idempotency key
    atomically persist Conversation + Message + Run
  GET /v1/runs/:runId/events
    stream typed semantic events
  Electric API read models
    hydrate Conversation, Message, Run, approval, and engine-session state

Runner
  claim queued Run with a fenced lease
  execute opencompany, Codex, or Claude Code adapter
  persist Messages, Events, artifacts, approvals, usage, and terminal state
```

Relevant web entry points:

- `apps/web/components/Surface.tsx`: composer, stream presentation, approvals, attachments,
  interruption, and coding runtime UI.
- `apps/web/lib/headless-chat-transport.ts`: canonical AI SDK transport and background sends.
- `apps/web/lib/headless-chat-commands.ts`: Conversation updates, cancellation, approvals, and
  runtime access.
- `apps/web/lib/headless-chat-collections.ts`: fixed API-owned read-model collections.
- `apps/web/lib/chat.ts`: Server Component Conversation metadata reader through the typed client.

opencompany, Codex, and Claude Code are explicit versioned engine descriptors on the same Message
command. opencompany is selected by default for non-coding chats, but the API does not infer a
missing engine. Message commands also carry `X-OpenCompany-Protocol-Version`; stale browser builds
are rejected with an instruction to refresh rather than being parsed through a legacy contract.
Attachments are uploaded to `/v1/attachments` and referenced by opaque IDs. Credential or storage
locator fields never enter client DTOs.

## Tasks and Workflows

Manual, Workflow, schedule, and agent producers call shared application services. Creation writes a
Task, its Conversation, initial Message, and Run atomically. Follow-ups use the Message command and
cancellation targets the active Run. The runner applies per-Conversation FIFO, fenced leases, retries,
and terminal settlement.

The 35 known sessionless pre-cutover Tasks are intentionally separate. They remain readable through
the actor-scoped compatibility API and cannot be replied to, canceled, or archived. ADR 0002 owns
their retention gate.

## Knowledge and integrations

Brain, Wiki, Skills, and integration commands are API- or runner-owned. Browser reads use fixed
authorized API read models, including `integration-accounts-v1`. The generic web Electric shape
proxy is deleted; clients cannot select physical tables or predicates.

## Ownership rules

- Public contracts and the typed client: `packages/protocol`.
- Application services and ports: `packages/core`.
- Database adapters and schema: `packages/db`.
- Provider-neutral agent behavior: shared packages such as `packages/agent`.
- Public HTTP composition: `apps/api`.
- Durable worker composition: `apps/runner`.
- UI and Server Components: `apps/web`.

All `/v1` routes require Actor authentication. Browser cookie mutations additionally enforce the
allowed `Origin`. Command retries retain existing idempotency semantics, and schema changes require
additive Drizzle migrations.

The web WorkOS routes, cached API-backed identity resolver, and `activateWorkspace` remain the
permanent browser-authentication shell. Production web code has zero `@opencompany/db` and zero
`drizzle-orm` imports; the boundary check has no exception list or migration baseline.

## Local verification

Use the repository scripts from the root:

```bash
bun run dev:community # credential-free web/API/runner + embedded Postgres
bun run smoke:local   # API and runner health
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Internal maintainers use `bun run setup` followed by `bun run dev:web` when the change requires
opencompany provider projects. Community mode reports provider-backed capabilities as disabled.

Do not start a second development server if one is already running. For UI changes, verify a real
message round-trip, reload durability, one obvious failure state, and the relevant Task or coding
engine path.
