# opencompany system map

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
and terminal settlement. An opencompany Task turn uses the same host-tool contract and runtime tool
composition as an interactive opencompany turn; the Task context adds autonomous-run instructions,
larger call budgets, and the headless action policy that denies operations requiring live approval.
Codex and Claude Code Tasks support one-time approval of connected actions set to Ask. The runner
persists the exact inputs, stops the engine, and parks the Run and Task until the user approves or
denies the request. Approval keeps the standing permission unchanged and queues the same Run.
The runner claims and executes the saved invocation before resuming the engine with its result.
Repeated requests for the same action and inputs reuse the result within that Run; changed inputs
require a new approval. If a worker dies after claiming an external write but before recording its
result, recovery reports an uncertain outcome for inspection and does not repeat the write.

Canonical Tasks can be archived once their run has settled, including `waiting` ("Waiting for you"),
`succeeded`, `failed`, and `canceled`. Archiving preserves the outcome and waiting state; it does not
resume execution. The UI and archive repository share this status rule in `@opencompany/core`.

The 35 known sessionless pre-cutover Tasks are intentionally separate. They remain readable through
the actor-scoped compatibility API and cannot be replied to, canceled, or archived. ADR 0002 owns
their retention gate.

## Knowledge, Skills, Plugins, and integrations

Brain, Wiki, Agent Skills, Agent Plugins, and integration commands are API- or runner-owned. Skills
and Plugins are immutable packages installed by exact resolved commit. Chats snapshot immutable
bundle and Plugin IDs; Workflow Tasks pin bundle IDs per step in their Harness spec. The runner
mounts those exact versions, and only integrity-approved stdio MCP servers are exposed to Codex or
Claude coding sandboxes. Plugin writable data is restored and checkpointed through bounded Blob
archives.

Browser reads use typed `/v1` resources and fixed authorized API read models, including
`integration-accounts-v1`. The generic web Electric shape proxy and the legacy `/api/skills`
response adapter are deleted; clients cannot select physical tables or predicates.

The official **GitHub as you** Plugin uses the personal `github_user` connection for
user-authorized tools and coding-sandbox git/gh access. Plugin settings read the user token's
reachable App installations and repositories from GitHub. A tool or sandbox git failure that is
confirmed outside that intersection links back through the combined install-and-authorize flow;
the client uses bounded, backoff polling with ordinary access reads instead of depending on
GitHub's setup redirect, which can omit OAuth state for an existing installation. An explicit
re-check may refresh the expiring user token once per install attempt.

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

## Bots

Bots are named, persistent conversations. `GET/POST /v1/bots` and
`GET/PATCH /v1/bots/:botId` expose a name (1–80 characters) and description (up to 4,000
characters). Creation takes a client-generated `id` retained across retries and atomically
creates an empty Chat Conversation and its workspace-bound idle runtime. It does not start a Run.
Bots belong to their creating user within the selected workspace, matching Chat ownership.

The `goat.users.bots_enabled` feature flag defaults to false. Enable it for selected users through
the existing database administration process; no environment variable is needed. The flag gates
bot API access and navigation. With it enabled, the sidebar shows Bots above recent chats, and
bot conversations have a settings button that opens an editor on the right. Bot Conversations
are excluded from the recent-chat API and Electric sidebar collections, including when disabled.

Messages, history, tools, approvals, cancellation, and runner sessions use the existing Chat
paths. Each runner engine reads the saved identity when preparing a turn and adds it as
user-authored guidance. Edits affect subsequent turns; they preserve history and the runtime.
Automatic title generation leaves bot names alone. There are no autonomous schedules or extra
bot tools in this first version. Migration `0261_persistent_bots` is additive; application rollback
can leave its columns and projection deployed without deleting bot conversations.
