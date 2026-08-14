# OpenCompany app and runner map

This document describes the current product flow. The web app presents Chat, Tasks, Workflows,
Brain, Wiki, integrations, and settings; the canonical API owns public commands and read models;
the runner owns durable execution.

## Chat

```text
GoatSurface
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
  execute OpenCompany, Codex, or Claude Code adapter
  persist Messages, Events, artifacts, approvals, usage, and terminal state
```

Relevant web entry points:

- `apps/web/components/GoatSurface.tsx`: composer, stream presentation, approvals, attachments,
  interruption, and coding runtime UI.
- `apps/web/lib/headless-chat-transport.ts`: canonical AI SDK transport and background sends.
- `apps/web/lib/headless-chat-commands.ts`: Conversation updates, cancellation, approvals, and
  runtime access.
- `apps/web/lib/headless-chat-collections.ts`: fixed API-owned read-model collections.
- `apps/web/lib/chat.ts`: Server Component Conversation metadata reader through the typed client.

OpenCompany, Codex, and Claude Code are versioned engine descriptors on the same Message command.
Attachments are uploaded to `/v1/attachments` and referenced by opaque IDs. Credential or storage
locator fields never enter client DTOs.

## Tasks and Workflows

Manual, Workflow, schedule, and agent producers call shared application services. Creation writes a
Task, its Conversation, initial Message, and Run atomically. Follow-ups use the Message command and
cancellation targets the active Run. The runner applies per-session FIFO, fenced leases, retries,
and terminal settlement.

The 35 known sessionless pre-cutover Tasks are intentionally separate. They remain readable through
the actor-scoped compatibility API and cannot be replied to, canceled, or archived. ADR 0002 owns
their retention gate.

## Knowledge and integrations

Brain, Wiki, Skills, and integration commands are API- or runner-owned. Browser reads use fixed
authorized API read models. The only physical collection still selected through the web Electric
proxy is the scoped integration status collection; Conversation and Task state use canonical read
models.

## Ownership rules

- Public contracts and the typed client: `packages/protocol`.
- Application services and ports: `packages/core`.
- Database adapters and schema: `packages/db`.
- Provider-neutral agent behavior: shared packages such as `packages/goat-agent`.
- Public HTTP composition: `apps/api`.
- Durable worker composition: `apps/runner`.
- UI and Server Components: `apps/web`.

All `/v1` routes require Actor authentication. Browser cookie mutations additionally enforce the
allowed `Origin`. Command retries retain existing idempotency semantics, and schema changes require
additive Drizzle migrations.

## Local verification

Use the repository scripts from the root:

```bash
bun run setup
bun run dev:web
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Do not start a second development server if one is already running. For UI changes, verify a real
message round-trip, reload durability, one obvious failure state, and the relevant Task or coding
engine path.
