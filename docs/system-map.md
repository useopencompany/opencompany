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

A coding session that opens a pull request gets a status badge on its sidebar row, for ordinary
chats and Tasks alike. The runner records the link while the turn streams — from the hosted GitHub
MCP `create_pull_request` tool or from `gh pr create` output, never from assistant prose — into
`goat.session_pull_requests`, keyed on `chat_sessions` so both kinds of row read the same table.
`GET /v1/session-pull-requests` returns those links, refreshing any non-terminal PR against GitHub
behind a 60s TTL with the caller's own user token; merged and closed are final and never re-read.
There is no GitHub webhook ingress, and this feature does not add one.

Claude Code coding chats and Workflow steps share the model catalog in
`packages/agent-runtime/src/models.ts`. Claude Opus 5 is available as
`anthropic/claude-opus-5`, mapped to `claude-opus-5` for sandbox execution, with reasoning-effort
controls and a 1M-token context window. Claude Sonnet 5 remains the default.

## Tasks and Workflows

Manual, Workflow, schedule, and agent producers call shared application services. Creation writes a
Task, its Conversation, initial Message, and Run atomically. Follow-ups use the Message command and
cancellation targets the active Run. The runner applies per-Conversation FIFO, fenced leases, retries,
and terminal settlement.

Main Chat cannot create a one-off Task. The agent's delegation move is `start_workflow`, which runs
an active workspace Workflow as a tracked Task, plus the recurring-schedule tools. There is no
`start_task` operation in the host-tool contract, so the capability cannot be reached from any chat
surface; `POST /v1/tasks` remains the producer for manual Task creation outside the agent loop.

An opencompany Task turn uses the same host-tool contract and runtime tool composition as an
interactive opencompany turn, with Workflow and schedule tools restricted to main Chat
conversations. The persisted host service checks the conversation kind on every call, so a Task
cannot start a Workflow or manage schedules even through a direct tool request. Task bootstraps omit
these tools and their routing instructions. The Task context adds autonomous-run instructions,
larger call budgets, and the headless action catalog. All Task engines support one-time approval of
connected actions set to Ask; headless callers without a durable Task still deny these requests.
The opencompany engine uses its existing AI SDK approval continuation: the Run and Task pause for
the user's decision, then the same tool call resumes with the recorded approval or denial.
For Codex and Claude Code Tasks, the runner
persists the exact inputs, stops the engine, and parks the Run and Task until the user approves or
denies the request. Approval keeps the standing permission unchanged and queues the same Run.
The runner claims and executes the saved invocation before resuming the engine with its result.
Repeated requests for the same action and inputs reuse the result within that Run; changed inputs
require a new approval. If a worker dies after claiming an external write but before recording its
result, recovery reports an uncertain outcome for inspection and does not repeat the write.

Workflows carry the same visibility model as Skills. A company workflow belongs to the workspace:
every member sees it, runs it with `#`, and can edit it. A personal workflow is visible only to its
creator, who is also the only one who can run or edit it. Workflows created before visibility
existed are company workflows. Only the creator — or an admin, for a workflow with no recorded
creator — can change a workflow's visibility. A workflow can be fired by anyone who can see it, so
it still draws Skills from the company scope only, whatever its own visibility.

Workflows start as Draft and can save steps without instructions. Activation requires instructions
in every step for manual, scheduled, and event triggers. In the editor, adding an empty step or
clearing instructions returns the workflow to Draft; completing the steps does not reactivate it.
Saving a scheduled draft clears its next run and prepared execution plan. There is one editable
workflow definition, so Draft also pauses future runs; it is not a separate unpublished version.
Plugin event setup, delivery guarantees, and Wiki ingestion retirement are documented in
[Plugin events and workflows](plugin-events.md).
Scheduled and event runs follow the step instructions. The editor does not author extra run
context; the trigger prompt saved with a workflow is only the run's opening request and stays
editable through the headless Workflow API.

The editor's Advanced section carries workflow memory: one markdown document per workflow, off by
default. While it is on, the current memory is injected into every run's system context and the run
gets `read_workflow_memory` and `update_workflow_memory` (whole-document replace, capped at 20,000
characters). Memory lives in `goat.workflow_memories`, not in the workflow row, so a run rewriting
its memory never bumps the definition's version or reorders the workflow list, and toggling memory
takes effect on the next run without re-planning a scheduled workflow's execution plan. It is served
by `/v1/workflows/{workflowId}/memory` (GET, PATCH for the toggle, DELETE to clear) and is not part
of the workflow read model.

Canonical Tasks can be archived once their run has settled, including `waiting` ("Waiting for you"),
`succeeded`, `failed`, and `canceled`. Archiving preserves the outcome and waiting state; it does not
resume execution. The UI and archive repository share this status rule in `@opencompany/core`.

The 35 known sessionless pre-cutover Tasks are intentionally separate. They remain readable through
the actor-scoped compatibility API and cannot be replied to, canceled, or archived. ADR 0002 owns
their retention gate.

Workspace Slack Channels bind exact bot-authored threads to these same durable Task conversations.
See [Slack Channels](slack-channels.md) for the subscription inbox, delivery outbox, authorization,
and reconnect/expiry behavior.

## Knowledge, Skills, Plugins, and integrations

Brain, Wiki, Agent Skills, Agent Plugins, and integration commands are API- or runner-owned. Skills
and Plugins are immutable packages installed by exact resolved commit. Chats snapshot immutable
bundle and Plugin IDs; Workflow Tasks pin bundle IDs per step in their Harness spec. The runner
mounts those exact versions, and only integrity-approved stdio MCP servers are exposed to Codex or
Claude coding sandboxes. Plugin writable data is restored and checkpointed through bounded Blob
archives.

Session tools can edit workspace-authored Skills with `edit_workspace_skill`: `name` selects the
installation by ID or unambiguous current name, and optional `newName`, `description`, and
`instructions` replace only the supplied fields. `newName` also changes the slash command and
`@skill` handle. Renames preserve the installation ID and immutable Chat/Task snapshots. Read the
latest saved Skill first and pass its `expectedBundleId` to reject stale edits.

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

Sandbox `gh` and HTTPS Git requests use an attempt-scoped GitHub broker. A private Unix
socket carries `gh` HTTP traffic; a Git HTTPS remote helper carries Git traffic through an
authenticated loopback relay without changing repository remotes. The runner checks the active
attempt, lease, and workspace membership on every request, then resolves the current personal
credential. Provider tokens stay in the runner. A GitHub 401 gets one conditional refresh and
one replay of that rejected HTTP request; transport errors, 403s, and server errors do not
replay mutations. This allows overlapping runs to survive shared OAuth rotation, including
rotation in the middle of a CLI command. GitHub requests have a 128 MiB body limit.

`GH_TOKEN` inside these sandboxes authenticates the local relay, not GitHub directly. Agents
use `gh api` for authenticated API requests. Download redirects to other hosts travel directly
from the sandbox over HTTPS without broker or GitHub credentials. The broker uses the existing
runner public URL and internal signing secret; it requires no new deployed environment variables.

## Ownership rules

- Public contracts and the typed client: `packages/protocol`. The barrel and `/client` both pull
  in `src/routes.ts`, so only `apps/api` and `apps/web`, which consume the router contract itself,
  should import them. Code that just needs a DTO imports `@opencompany/protocol/schemas` or
  `/events`, which are router-free. `bun run boundary:check` enforces this.
- Application services and ports: `packages/core`.
- Database adapters and schema: `packages/db`.
- Provider-neutral agent behavior: shared packages such as `packages/agent`.
- Public HTTP composition: `apps/api`.
- Durable worker composition: `apps/runner`.
- UI and Server Components: `apps/web`.

All `/v1` routes require Actor authentication. Browser cookie mutations additionally enforce the
allowed `Origin`. Command retries retain existing idempotency semantics, and schema changes require
additive Drizzle migrations.

The onboarding plugin step permits browser sessions with workspace membership to list plugins
(`GET /v1/plugins`), preview imports (`POST /v1/plugins/imports/preview`), and install them
(`POST /v1/plugins/imports`) before onboarding completes. The preceding subscription step can also
read and connect Claude Code and Codex through the narrow `/v1/engine-auth/*` setup routes it uses.
These exceptions apply only to browser sessions with an existing workspace membership; they retain
Actor resolution, workspace permissions, origin checks, and rate limits. Ordinary product routes
and bearer-token callers still require completed onboarding.

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

The `goat.users.bots_enabled` feature flag defaults to false. Users can enable or disable it in
Preferences → Beta features → Bots. The switch saves `botsEnabled` through
`PATCH /v1/me/preferences` and refreshes the app shell; no environment variable is needed. The flag gates
bot API access and navigation. With it enabled, the sidebar shows Bots above recent chats, and
bot conversations have a settings button that opens an editor on the right. Bot Conversations
are excluded from the recent-chat API and Electric sidebar collections, including when disabled.

Messages, history, tools, approvals, cancellation, and runner sessions use the existing Chat
paths. Each runner engine reads the saved identity when preparing a turn and adds it as
user-authored guidance. Edits affect subsequent turns; they preserve history and the runtime.
Automatic title generation leaves bot names alone. There are no autonomous schedules or extra
bot tools in this first version. Migration `0261_persistent_bots` is additive; application rollback
can leave its columns and projection deployed without deleting bot conversations.

## Resource ID naming

New browser and server resource IDs use the shared `@opencompany/core/resource-ids` factory:
`conversation_`, `workspace_`, `workflow_`, `task_schedule_`, `share_`, `artifact_`, and
`artifact_version_`, followed by a full random UUID. Schedule runs use `workflow_schedule_run_`
and `task_schedule_run_`. Tasks already use `task_` IDs and retain their human-facing display IDs.

Persisted IDs are opaque: existing IDs, references, and links are not rewritten. Chat reservation,
share, and workspace validators accept the legacy prefixes as well as the current formats. Public
share IDs remain independent, unguessable capabilities. New share links require the updated API
and web validators; deploy those readers before enabling new writers in a staggered release, and
retain reader compatibility when rolling back. Physical database names, storage roots, provider
contracts, and deterministic ingestion IDs retain their existing names.
