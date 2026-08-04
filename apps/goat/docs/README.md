# Goat LLM System

This is the current-state map of how Goat answers chat messages and runs durable LLM tasks. It is
intended as a baseline before changing the system.

For the Brain (Goat's knowledge store — data model, ingestion, tools, contracts), see the
[brain section](./brain/README.md).

## Current Shape

Goat has three LLM paths:

1. **Foreground chat:** a short-lived AI SDK stream from the browser to `apps/goat/app/api/chat`.
   This agent answers directly, reads connected integrations, calls `goat_brain`, captures with
   `save_to_brain`, calls `start_task`, or explicitly starts an active workspace workflow.
2. **Background task:** a durable row in `goat.tasks` claimed by `apps/runner`, planned into a
   `goat.harness.v1` config, then executed by an AI SDK model loop in the runner process.
3. **Persistent cloud coding chat:** Goat chat engine modes for Codex and Claude Code backed by a
   persistent E2B sandbox. Uploaded images, PDFs, Word files, Excel files, and SRT subtitles are
   materialized into that sandbox. Each engine keeps its own resumable thread/session state and
   trusted working directory. Codex additionally receives images as native local-image inputs; new
   Codex chats pin the active Brain and expose its read plane and capture-first save path through
   runner-hosted dynamic tools. Both Codex and Claude Code chats expose the same read-only
   integration action catalog (`list_actions`/`use_action`, `apps/goat/lib/codex-actions.ts`) —
   Codex through app-server dynamic tools, Claude Code through a turn-scoped internal MCP server
   (`apps/goat/app/api/internal/claude-actions`) since that is Claude Code's only custom-tool
   mechanism. Brain tools remain Codex-only for now.

The Goat task path is not currently a full OpenCompany `.agent` session. It reuses runner
infrastructure, Vercel AI Gateway, leases, observability, and server-side tools, but it
does not yet use `agent_sessions`, `.agent` files, Brain mounts, skills, approvals, or
`delegate_to_agent`. It does expose selected user-scoped MCP integrations through the Goat
task harness, including Linear and Latitude.

The wider OpenCompany runner does have a full multi-agent session loop. Goat can either keep its
lighter task harness and grow it, or move durable Goat work onto that full session substrate.

## High-Level Flow

```text
Browser
  GoatSurface useChat()
    POST /api/chat
      persist user chat message
      streamText(default Goat chat agent)
        answer directly
        OR call goat_brain
        OR survey connected integrations with list_actions/use_action
           and capture focused findings with save_to_brain
        OR, when Tasks & Workflows is enabled in Preferences, call start_task
          insert goat.tasks row
          POST /internal/goat/tasks/:taskId/run
        OR, when the user explicitly asks to run an active workflow, call start_workflow
          compile the workflow and insert its goat.tasks row
          POST /internal/goat/tasks/:taskId/run
  GoatSurface #task / #workflow submit
    POST /api/tasks or /api/workflows
      insert goat.tasks row without creating a chat session or chat messages
  GoatSurface cloud coding modes
    POST /api/codex-chat/messages or /api/claude-chat/messages
      persist the message and attachment metadata
      enqueue a turn for the shared cloud coding chat worker

Runner
  Goat task worker wakes/polls
    claim queued task with lease
    plan harness spec with Gateway planner model
    create durable assistant task message
    streamText with Gateway, Exa, Gmail, Calendar, Linear MCP, and Latitude MCP tools
      append durable message and tool events
    use final assistant message as the task result
    mark task succeeded, failed, or canceled

Goat UI
  subscribes to Electric task, chat, and cloud coding shapes
```

## Foreground Chat Loop

Entry points:

- `apps/goat/app/page.tsx`
- `apps/goat/components/GoatSurface.tsx`
- `apps/goat/app/api/chat/route.ts`
- `apps/goat/lib/chat.ts`
- `apps/goat/lib/chat-agent.ts`
- `apps/goat/lib/chat-ui.ts`

`GoatHomePage` loads two things server-side: the current user's unarchived tasks and the most
recent open chat session. It passes those into `GoatSurface`.

`GoatSurface` owns the browser chat loop with `useChat` from `@ai-sdk/react`. Its
`DefaultChatTransport` posts to `/api/chat` and sends:

- `sessionId`: the open chat session if one exists.
- `newSessionId`: a browser-reserved UUID when the message starts a new chat.
- `model`: the current chat model.
- `message`: only the newest UI message.

The composer can attach the workspace's skills (`goat.skills`) with `@skill/<slug>`. The visible
token is paired with structured `{ kind: "skill", id }` metadata (`id` is the workspace-scoped
skill slug). Exact skill tokens pasted into the composer are resolved against the workspace catalog,
while manually typed lookalikes stay plain text. The server resolves that metadata again under the
current user's active workspace, rejects unavailable references, and caps a turn at 16
skills / 256 KiB of canonical `SKILL.md` content. The first valid mention stores an immutable snapshot
in `goat.chat_session_skills`; re-mentioning the same id keeps that session's original version.

Selecting a workflow with `#<id>` changes the composer action from **Send message** to **Start
task**. Submission posts directly to `/api/workflows`, creates a task-flavored chat session and its
first durable turn, and leaves the current Home or chat surface in place. It does not call the
foreground chat model.
Skills mentioned by the workflow are resolved and snapshotted when the task is created. OpenCompany
task runs receive those snapshots as workflow prompt blocks; Codex task runs materialize them under
`.agents/skills` and invoke them as native app-server skill inputs, matching explicit skill mentions
in main Codex chat.

The reserved `#task` token provides the same direct composer handoff for one-off work without a
saved workflow. The composer posts the request to `/api/tasks`, removes the directive from the
runner prompt, creates a task chat session with the selected model, and keeps the current surface
in place. Both `#task` and saved workflow mentions require the **Tasks & Workflows** preference and
currently reject attachments.

Workflow runs and `#task` ad-hoc runs remain grouped under **Tasks**, but task detail renders the
same `GoatSurface` as a normal chat. User-triggered Codex and Claude Code sessions remain ordinary
Chats unless they are backed by a `goat.tasks` row. Session-backed tasks render their native
`goat.chat_messages` and subscribe to the same session and durable-turn state as cloud chats. The
standard reply composer appends a user message and durable turn on that session, preserving its
complete message and tool context. The normal chat stop control interrupts the active turn. Rows
created before the session cutover retain a read-only compatibility projection from
`goat.task_messages`.

Normal main chat can also discover workspace skills progressively. When the catalog is non-empty, the
system prompt advertises only that a skill source exists; `list_skills` searches safe id, name, and
description metadata, and `use_skill` loads the full instructions for one exact returned id. The
successful tool result stays in conversation history, so model-selected skill instructions remain
available on later turns without being copied into the system prompt or delegated tasks. Explicit
and model-selected skills share the same per-turn limit of 16 skills / 256 KiB of instructions.

The composer also accepts PDF, DOCX, XLSX, SRT, PNG, JPEG, and WebP files. SRT MIME values are
normalized because browsers report them inconsistently. Foreground chat stores bounded extracted
SRT text for the initial and follow-up turns; persistent cloud coding chats receive the original
file in their sandbox.

When a new chat is submitted, the client reserves its final `goat_chat_<uuid>` id and moves to the
matching `/chat/<id>` URL immediately with the native History API, without starting a server
navigation; the server persists that exact id. The stream attaches `sessionId` in message metadata so
the client can confirm ownership and start the authorized message subscription. Persisted chat
sessions and messages then arrive through TanStack DB collections backed by Electric shapes. Other
persisted Goat app state such as tasks, task run events, integrations, and Brain documents uses the
same live-data path.

Stopping generation calls `stop()`, which aborts the HTTP request. Closing chat clears local state,
optionally stops the active stream, and marks the chat session closed through
`closeGoatChatSessionAction`.

### Public read-only chat links

The link button in a persisted chat header opens sharing controls. The owner can create or reuse
one opaque `goat.chat_session_shares` token for their session, copy `/share/<token>`, or stop
sharing. Stopping sharing deletes the token so the public transcript and its attachment routes stop
resolving immediately. Sharing again creates a new token; a revoked URL never becomes valid again.
Shared routes sit outside the authenticated Goat app shell, render the existing transcript UI
without a composer or mutation controls, and can serve that session's attachments through a
token-scoped byte route. The link reads the current session on each request, so later messages are
included; the copy confirmation says this explicitly. Normal `/chat/<id>` routes remain
authenticated. Share pages are excluded from search indexing, and the token never grants access to
any other session data.

## `/api/chat`

`POST /api/chat` does the foreground work:

1. Authenticates the current Goat user.
2. Parses and validates the submitted UI message, model, and optional session id.
3. Requires `VERCEL_AI_GATEWAY_API_KEY`.
4. Finds or creates an open `goat.chat_sessions` row.
5. Persists the user message in `goat.chat_messages`.
6. Resolves active-Brain skills, active workspace workflows, connected-integration actions, and the
   workspace's managed social/lead capabilities, then creates the chat tool context for `goat_brain`,
   `save_to_brain`, `list_skills`/`use_skill`, `list_actions`/`use_action`, optional `start_task`,
   `start_workflow`, and optional `web_fetch`/`web_search`.
7. Calls `streamText` through Vercel AI Gateway with the session's model.
8. Streams the UI message response back to the browser.
9. Persists the assistant message, debug trace, and optional task link on finish.

The first message fixes the model for that chat session. The Home composer remembers the latest
selection for the next chat, while an active chat keeps its stored model even if that Home preference
changes in another tab.

When a background task that was started from chat succeeds or fails, the runner appends a synthetic
assistant message to the originating chat session if that session is still open. The message includes
the task link and final result or error so the next user reply has the completed task in context.
This is only a persisted notification; Goat does not automatically spend another foreground chat
model turn when the task finishes.

The chat agent's system prompt is built by `createOpenCompanyChatSystemPrompt`, assembled from
structured blocks in `apps/goat/lib/prompts/main-chat.ts`. The route injects runtime context such as
the current date and a compact DB-backed `user_context` profile with the user's name, email, and
timezone. `goat_brain` is always available. When Exa is configured, `web_fetch` reads up to four
known URLs per chat turn through the Contents API while `web_search` discovers current public-web
sources through Search.
Connected integration and managed capability actions are dispatched through `list_actions` and
`use_action`. The route resolves one compact source catalog from currently connected providers and
the workspace's enabled managed capabilities, and the model must discover a source's concrete action
ids and parameter schemas before executing one. Slack exposes
conversation, message, thread, member, and scope-dependent search reads under one **Read Slack**
permission, which defaults to **On** and can be changed to **Ask** or **Off** under Integrations.
Gmail exposes message search, message and thread retrieval, explicitly requested plain-text draft
creation, and explicitly requested sends, with an explicit account required when several are
connected. Draft creation and sending have separate per-account permissions: creating drafts defaults
to **On** because it leaves the email for manual review and sending, while sending defaults to
confirmation-gated **Ask**. Google Calendar exposes a bounded event-list read, while Google Drive
exposes file search, live Google Doc and Sheet reads, new Doc creation with optional initial text,
exact text replacement in Google Docs, and Sheet value updates or appends. Linear exposes
a curated catalog for reading issues and workspace context, creating and updating issues, and adding
comments. Attio exposes bounded fuzzy search across standard people, companies, and deals; list,
field, and membership discovery; and bounded list reads with saved-view filters, explicit filters,
sorting, and pagination. Explicitly requested Gmail sends, Google Doc creation or edits, Attio record
and list-entry updates, Linear writes, and Google Calendar event creation require confirmation by
default and can be configured under Integrations. Latitude's live MCP catalog is mapped into the same
action surface: tools annotated read-only default to On, while mutations and tools without that
annotation default to Ask. An explicit account or workspace is required when several are connected.
Neon's hosted MCP catalog is constrained to its provider-enforced read-only mode and a local tool
allowlist: project, branch, table, and schema inspection defaults to On, while SQL queries default to
Ask. Persistent coding sessions only receive SQL access after the user explicitly changes that
permission to On, and connection-string or mutation tools are never exposed.
Stripe exposes read-only workspace
metrics for balance activity by period, current balances, subscription health with estimated MRR,
and open receivables. Stripe uses an encrypted restricted API key and is excluded from automatic
Brain-fill surveying because those financial metrics are live operational state. Disconnected or
disabled capabilities are absent from the catalog, guessed action ids cannot bypass it, and all
provider credentials remain server-side. Deeper or multi-source connected-account work continues
through background tasks.

Managed X, LinkedIn, YouTube, Instagram, TikTok, prospecting, and Semrush SEO actions use a fixed
server-to-server endpoint allowlist in `apps/goat/lib/capabilities/catalog.ts`. Prospecting includes
bounded PDL person search across current title and seniority, person or company location, company
industry, provider-estimated company employee count, and work-email availability. When the user
already knows whom they want to contact, the focused PDL person-enrichment action accepts a LinkedIn
URL or a full name plus company/location, requires a confidence-gated work email, and returns one
compact contact record without running a broader prospect search. Every paid execution inspects its
live endpoint schema and price before running,
checks shared workspace credits, and requires a one-time approval above the per-action or per-turn
thresholds. Provider data is treated as hostile input, redacted and bounded before it enters the chat
trace, and billed once from the settled provider cost plus the platform fee. The durable
`goat.capability_runs` row stores only the parameter hash and lifecycle/cost metadata; only the
safety-bounded action result enters the requesting chat. The hourly billing reconciler settles
interrupted or delayed runs.
YouTube transcript actions fetch one full timestamped transcript through a reviewed Monid-backed
Apify actor and validate that it belongs to the requested video. `youtube.get_transcript` returns
the complete transcript as one plain-text result with video and language metadata, using a larger
action-result allowance reserved for this validated shape; oversized transcripts fail explicitly
instead of being silently truncated. `youtube.find_in_transcript` searches the same provider result
server-side and returns only bounded timestamped context windows for a requested phrase.
`MONID_API_KEY` belongs in Infisical `prod` + `/goat`, and
`GOAT_MANAGED_CAPABILITIES_KILL_SWITCH=true` removes managed sources from new turns.
`GOAT_DISABLED_MANAGED_CAPABILITY_ACTIONS` accepts comma-separated action ids for endpoint
isolation. Managed sources never participate in automatic Brain-fill surveying; the user must
explicitly ask to save their results.

Managed X profile discovery uses X's People-ranked search rather than an exact bio-field predicate.
It can also page through the public followers of a supplied profile with the provider's opaque
cursor.

Run `bun run goat:capabilities:contract` with `MONID_API_KEY` to inspect every allowlisted
endpoint and fail on removal or pricing/input-contract drift, including whether parameters belong
in the request body, query, or path. The command never calls the paid run API and is intentionally
opt-in.

When connected integrations and an active brain are present, a conditional `brain_fill` prompt
teaches the agent to survey breadth before depth, page promising sources, save focused findings
with canonical provenance, summarize the pass, and ask what to deepen. This fill workflow stays in
main chat even though ordinary deeper or multi-source work routes to a background task.
`start_task`, `start_workflow`, workflow mentions and routes, and the recurring schedule tools,
prompt guidance, schedule context, background-task rows, routines, and runner claims are enabled
only when the user opts into **Tasks & Workflows** in Preferences. When disabled, Tasks and
Workflows stay out of the primary navigation and direct routes show the beta opt-in prompt. The
database flag defaults off, so the standard Goat experience is chat plus Brain without workflows
or background task spawning. `start_workflow` is advertised only when active workflows exist and
is reserved for explicit requests; name and description matches alone do not authorize a run. Tool
descriptions live in `packages/goat-agent/src/prompts/tool-descriptions.ts`.

The default chat model is `moonshotai/kimi-k3`. New tasks store the chat-selected model at
creation time, then the runner planner chooses the task execution model from its allowed model
catalog and writes that planned model back to the task row.

Important runtime settings:

- `maxOutputTokens: 900`
- `stopWhen: stepCountIs(8)`
- `abortSignal: request.signal`

The chat path is a normal request/response stream. It has no runner lease or durable retry. The
durable boundary starts when `start_task` or `start_workflow` creates a task row.

Brain skills are user-authored, session-scoped context. Normal chat replays each immutable skill
snapshot on the historical user message that activated it, so the full instructions remain in model
history on later turns while visible chat content stays unchanged. Persistent cloud coding chats
materialize every snapshot under `.agents/skills/<id>/SKILL.md`. Codex sends newly activated skills
to app-server as native `skill` inputs and keeps invoked instructions in its persistent thread;
Claude Code receives the materialized skill paths in its turn prompt. Skills are not copied into
background, delegated, or recurring tasks.

## Persistent Cloud Coding Chats

Entry points:

- `apps/goat/components/GoatSurface.tsx`
- `apps/goat/components/CodingWorkspacePanel.tsx`
- `apps/goat/app/api/codex-chat/*` and `apps/goat/app/api/claude-chat/*`
- `apps/goat/app/api/coding-workspaces/*`
- `apps/goat/lib/codex-chat.ts`
- `apps/runner/src/goat-codex-chat.ts`
- `apps/runner/src/goat-claude-code-chat.ts`
- `apps/runner/src/goat-coding-workspace-runtime*.ts`
- `apps/runner/src/repo-bootstrap.ts`
- `apps/runner/src/codex-app-server.ts`

Codex and Claude Code use the same durable `goat.codex_chat_*` tables and worker queue; those legacy
database names remain the storage contract for both engines. Every open coding chat owns a
persistent sandbox, while the shared engine descriptor selects the trusted working directory:
`/home/user/opencompany-goat/codex-chat` for Codex and
`/home/user/opencompany-goat/claude-chat` for Claude Code.

Both engines expose the same Preview and Terminal workspace sidebar, collapsed by default. The
browser requests an owner-bound, short-lived ticket from
`POST /api/coding-workspaces/sessions/:chatSessionId/runtime-access`, then connects to
`/goat/runtime` with the `goat-coding-workspace-v1` WebSocket protocol. The runner revalidates the
open session and sandbox before connecting, chooses the working directory from its trusted engine
descriptor, and never accepts a directory from the browser. Preview URLs use signed,
session-and-port-bound capabilities and the runner proxy; Goat does not expose raw sandbox ids or
E2B hosts.

The sidebar is available only for persistent Codex and Claude Code chats. Foreground OpenCompany
chat, background tasks, scheduled runs, and tool sandboxes do not receive it. Opening the panel
alone does not wake a sleeping sandbox; selecting Preview or Terminal does. The terminal uses an
engine-neutral tmux session.

Claude Code turns run the Claude CLI in the Claude-specific working directory and resume its saved
session id after runner handoffs. Codex execution has additional app-server, Plan mode, interaction,
Brain, and dynamic-action behavior described below.

Workspace admins can configure per-repository environments and setup instructions under
`/settings/repositories`, and can remove a repository's saved configuration from the same page.
Before every Codex or Claude Code turn, the runner verifies that the turn owner is still a workspace
member and only loads configs for repositories currently available through a connected GitHub
installation. It decrypts those environment payloads host-side, reconciles changed files under
`/opt/oc/repos/<github-repository-id>/.env`, and adds only the staged path plus the plaintext setup
instructions to the engine prompt. Decrypted secret-like values also join the runner's known-secret
redactor so accidental command output cannot persist them in the chat transcript. Fingerprinted
reconciliation still checks warm sandboxes on every turn, while unchanged configurations skip file
uploads.

### Codex execution

The legacy-named `goat.codex_chat_turns` queue is the durable, per-session FIFO execution substrate
for `codex`, `claude_code`, and the internal-only `opencompany` engine path. A claimed OpenCompany
turn runs the shared AI SDK chat loop without a sandbox or engine thread, streams text, reasoning,
and tool lifecycle parts into its pre-created assistant `goat.chat_messages` row, and reconstructs
follow-up model history from those persisted UI message parts. Its headless tool catalog includes
read-only Brain/web tools and only integration actions whose permission mode is `on`; managed
capabilities and approval-gated actions are excluded. No product route selects this durable
OpenCompany path yet. It is exercisable only through the bearer-authenticated
`POST /api/internal/opencompany-chat/messages` endpoint, which accepts an explicit user, workspace,
prompt, and optional Brain/session/model before enqueueing through the same durable queue.

Cloud Codex uses a persistent sandbox per Goat chat and resumes the same Codex app-server thread on
follow-up turns. New turns remain `queued` until the runner claims them, then move through
`starting` and `running`; the worker uses the runner-wide concurrency setting rather than a
Cloud-Codex-specific limit. OpenCompany sessions leave the sandbox/thread columns null and are
ignored by terminal-sandbox reconciliation. The composer accepts the same private-blob uploads as
normal Goat chat.
At run time, the worker downloads the current turn's files into
`~/.opencompany-goat/codex-chat-attachments/<turn-id>/` and includes those paths in the user task.
Image uploads are additionally passed to `turn/start` as `localImage` inputs, so screenshots are
visible to the model rather than merely path-referenced. Keeping uploads outside the working
directory prevents them from appearing in repository changes.

The Codex app-server daemon runs behind its Unix-socket control transport inside E2B and outlives
the runner-side proxy. A runner shutdown stops new claims and gives the active turn up to four
minutes to finish on the existing proxy. If it is still running, shutdown detaches the proxy, keeps
the sandbox on its active timeout, releases the delivery lease, and lets the next worker
`thread/resume` the same stored Codex turn id. The reconnect reconciles completed
items and a terminal turn that landed while no runner was attached; stable per-item event keys make
that replay idempotent. Lease claims count infrastructure ownership changes, while
`recovery_attempts` increments only when the original Codex turn is missing or was interrupted and
the worker must start one guarded continuation. Persisting the replacement Codex turn id rearms
that guard for the new engine turn, so long-running chats can survive repeated deploys without
allowing two continuations for the same missing turn. A dead proxy with a pending user-input
request forces that guarded continuation because server-initiated requests cannot move between
client connections.

Transient E2B capacity, rate-limit, network, and acquisition-timeout failures defer the same durable
turn with bounded exponential backoff instead of writing a failed assistant message. Authentication,
template, and other configuration failures remain terminal. A deferred turn stays interruptible and
keeps later messages behind it in the per-session FIFO. Before the runner can invoke Codex, it
durably snapshots the engine thread's existing turn ids and marks the turn as requiring recovery.
This keeps pre-engine infrastructure retries distinct from post-invocation lease recovery, and lets
a replacement worker identify an unpersisted new engine turn without adopting older active work.

Session skills are reconciled before every Cloud Codex turn under
`/home/user/opencompany-goat/codex-chat/.agents/skills/`. The managed-skills manifest removes only
OpenCompany-managed ids and preserves any unrelated native skills. A content fingerprint restarts
the app-server daemon when the installed set changes, while the persistent Codex thread is resumed.
Only skills whose first activation belongs to the current turn are included as native `skill`
inputs; previously activated skills remain installed and in thread history.

New Cloud Codex chats pin the user's active Brain and workspace on `goat.codex_chat_sessions`
together with the host-tool contract version used to start the Codex thread. On `thread/start`, the
runner registers `goat_brain`, `save_to_brain`, `list_actions`, and `use_action` through app-server's
experimental `dynamicTools` API. The read-only `goat_brain` tool is handled directly by the runner.
`save_to_brain` calls a private Goat gateway with `RUNNER_INTERNAL_TOKEN`, rechecks the running turn
and current Brain access, then uses the same immediate-inbox-draft and background-curation pipeline
as main chat. Its content-derived idempotency key lets a recovered Codex turn reuse the same
completed capture.

The action gateway derives the user and workspace from the running turn, rechecks current workspace
membership, resolves current connections and permission settings, and exposes only integration
actions whose capability is `read` and permission mode is `on`. Writes, confirmation-gated actions,
and paid managed capabilities are not present in the Cloud Codex catalog. Provider credentials,
the internal bearer, and database access never enter E2B. A per-turn call budget bounds provider
reads.

Claude Code chats reach the same gateway (`executeGoatCodexActionGateway`) and the same read-only
policy, but through a different transport: the `claude` CLI runs entirely inside the sandbox and
only supports custom tools over MCP, so there is no host-side app-server relay to keep credentials
out of E2B the way Codex does. Instead, `apps/runner/src/goat-claude-code-chat.ts` mints a
short-lived, HMAC-signed ticket bound to that one `codexChatSessionId`/`codexChatTurnId`
(`packages/agent-runtime/src/goat-claude-action-gateway-auth.ts`, signed with
`RUNNER_INTERNAL_TOKEN` as the HMAC key) and writes it into an `--mcp-config` file pointing at
`apps/goat/app/api/internal/claude-actions`, a streamable-HTTP MCP server
(`apps/goat/lib/claude-actions.ts`) that verifies the ticket instead of the raw bearer token. The
ticket only proves "mint this turn's action calls"; it expires with the turn and cannot reach any
other internal route, unlike `RUNNER_INTERNAL_TOKEN` itself, which is deliberately never placed in
the Claude Code sandbox.

Because app-server stores dynamic tool definitions on the thread, resumed turns provide the
matching runner callbacks without trying to redefine the tools. Existing Brain-tool v1 sessions
remain Brain-only, and host-tool v2 sessions keep their read-only Brain and integration tools.
Host-tool v3 adds the capture-only `save_to_brain` path. The `goat_brain` contract itself
intentionally supports only `query`, `list`, `get`, and `timeline`; direct Brain mutations remain
unavailable.

The Cloud Codex Plan control starts the turn with app-server's experimental
`collaborationMode.mode = "plan"`; `plan_mode_reasoning_effort` configures the mode's reasoning
effort but does not activate Plan mode by itself. A successful Plan turn that produced a proposed
plan ends with an **Implement plan** choice. That action sends the same `Implement the plan.`
follow-up used by Codex's reference TUI and starts it in default collaboration mode. Keeping the
plan editable is a client-side choice rather than a special app-server approval RPC.

App-server user questions arrive as server-initiated `item/tool/requestUserInput` JSON-RPC
requests. The runner persists each request and its short-lived response in
`goat.codex_chat_interactions`, projects an
interactive question card into the Electric-synced assistant message, and waits while maintaining
the turn lease. The authenticated answer endpoint atomically resolves only a pending interaction
owned by the current user and running turn; the runner then returns the exact app-server response
shape. Timed questions auto-resolve with an empty answer map, matching the Codex TUI without
inventing a selection. Turn completion, interruption, timeout, and lease recovery cancel pending
interactions so stale cards cannot answer dead proxy connections. Cloud execution continues to use
`approvalPolicy: "never"` inside the isolated workspace-write sandbox; unexpected command or file
approval requests are declined rather than surfaced as misleading UI. Terminal and recovered turns
clear stored answer bodies after settling the UI, including answers to questions marked secret.
Native permission-escalation requests return an empty grant set for the same fail-closed reason.
Pending dynamic host-tool calls also force a guarded recovery, since their result belongs to the
runner proxy connection that received the original request.

On the Goat home, persistent Codex and Claude Code sessions stay in the Chats section because they
are user-triggered chat sessions. The Tasks section is reserved for real `goat.tasks` rows created
from `#task`, workflow, or schedule entry points. Selecting a coding chat still opens
`/chat/<session-id>`, while selecting a task opens `/tasks/<display-id>`.

## Task Creation

Entry points:

- `apps/goat/lib/tasks.ts`
- `apps/goat/lib/workflow-tasks.ts`
- `apps/runner/src/goat-scheduler.ts`
- `packages/db/src/goat-task-sessions.ts`

All ad-hoc, workflow, and scheduled task entry points call `createGoatTaskSession`. In one database
statement it:

- Creates a `goat.chat_sessions` row with `kind: "task"`.
- Inserts the thin `goat.tasks` projection linked through `session_id`.
- Inserts native user and pending assistant `goat.chat_messages`.
- Creates the engine runtime row and enqueues the first leased `goat.codex_chat_turn`.
- Persists the compiled harness, workflow, and schedule metadata on the projection.

Callers validate product permissions, compile or seed the harness, then wake the shared durable chat
worker. `GOAT_TASK_SESSION_EXECUTION_ENABLED=false` is a temporary rollback switch that routes new
tasks to the legacy task queue. It defaults to enabled. Existing rows without `session_id` continue
to drain through the legacy task worker and retain their old history.

Available OpenCompany task tools are resolved from the same user-specific Brain, web, browser, and
connected-action catalog as foreground chat. Codex task configuration still comes from the task
planner so repository selection, pull-request intent, reasoning effort, goal mode, and report mode
remain task-specific.

## Durable Task Turns

Entry points:

- `apps/runner/src/index.ts`
- `apps/runner/src/goat-codex-chat-worker.ts`
- `apps/runner/src/goat-opencompany-chat.ts`
- `apps/runner/src/goat-codex-chat.ts`
- `apps/runner/src/goat-task-turn.ts`

Tasks use the engine-agnostic durable turn worker and the same per-session FIFO, lease, heartbeat,
recovery, and assistant projection as cloud chat. Loading a turn whose chat has `kind: "task"`
loads its linked task projection. The adapter marks the task running, applies any needed planning,
and executes through the turn's selected OpenCompany or Codex engine.

One fenced settlement statement completes the turn and runtime session, updates the task
projection, and writes the origin-chat notification. Success maps to `succeeded/completed`, failure
to `failed/failed`, and interruption to `canceled/canceled`. A user reply to a terminal task queues
a new turn on the existing session without collapsing history.

`apps/runner/src/goat-worker.ts` remains only for rows with no `session_id`; it is a compatibility
drain path and does not claim session-backed tasks.

## Harness Planning

OpenCompany-engine tasks already carry their engine and model in `harnessSpec` and run directly on
the shared chat substrate. Codex-engine tasks call `planGoatHarnessForTask` to infer the coding
repository, pull-request behavior, reasoning effort, and optional goal-mode settings.

The planner is a separate AI SDK `generateObject` Gateway call using:

- Model: `anthropic/claude-sonnet-4.6`
- strict JSON schema
- Structured prompt blocks from `apps/runner/src/prompts/goat-harness-creation.ts`
- Execution engine options: `opencompany` by default, or `codex` for sandboxed Codex CLI coding
  tasks.
- Execution model options: `moonshotai/kimi-k2.6` by default for most work and deep research,
  `zai/glm-5.2` for very large-context or long source-set synthesis, `anthropic/claude-sonnet-5`
  as the premium fallback for explicit Claude/Sonnet, maximum-quality, polished writing, vision, or
  file-input cases, and `openai/gpt-5.5` for coding, Codex, or sharper analysis.

The planner returns a `GoatHarnessSpec`:

```ts
type GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1";
  engine: "opencompany" | "codex";
  model: AgentModelId;
  systemPrompt: string;
  initialUserMessage: string;
  tools: GoatTaskToolName[];
  skills: GoatTaskSkillId[];
  maxModelSteps: number;
  resultMode: "assistant_final" | "brain_markdown_report";
  codex?: {
    repository?: string | null;
    createPullRequest?: boolean;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    goalMode?: {
      objective: string;
      tokenBudget?: number | null;
    };
  };
};
```

Normalization is intentionally conservative:

- Tool names are operation-level only.
- Skills are reasoning/operating guidance only, selected from the planner's available skill list
  (`first-principles`, `yc-office-hours`) and injected into the execution system prompt.
- `maxModelSteps` is a runaway ceiling, not a difficulty estimate. The planner default is 16,
  browser-capable tasks are normalized to at least 16, and the runner reserves the final step for
  a no-tool answer.
- Legacy operation names in stored harness specs are normalized conservatively so old rows remain
  readable. OpenCompany-engine runs resolve the live shared chat tool catalog instead.
- The execution engine must be `opencompany` or `codex`. Missing legacy values normalize to
  `opencompany`.
- The execution model must be one of the planner's allowed model options.
- `systemPrompt` must be non-empty; there is no fallback task system prompt.
- `resultMode` is `assistant_final` for ordinary tasks and `brain_markdown_report` for deep
  research/report deliverables that should be saved as Brain artifacts.
- Codex engine runs use `codex.repository` for a Goat-connected GitHub repository and only open a
  draft PR when `codex.createPullRequest` is true.
- Codex engine runs may use `codex.goalMode` for iterative coding tasks with a clear finish line
  and verification surface. Objectives are trimmed to Codex's 4,000-character limit, omitted token
  budgets default to `200000`, and v1 goal-mode tasks run within one Goat worker execution.

The planner request and response content are stored in `debugTrace.planner`.

## Task Model Execution

Entry points:

- `apps/runner/src/goat-opencompany-chat.ts`
- `apps/runner/src/goat-codex-chat.ts`
- `apps/runner/src/goat-task-turn.ts`
- `packages/goat-agent/src/chat-agent.ts`

Task mode adds only the autonomous `TASK_SYSTEM_BLOCK`, the untrusted-content safety block, and
raised headless call limits to an OpenCompany turn. All other prompt, message, tool, streaming,
credit, and usage behavior is the standard chat adapter.

Task turns use their standard engine adapters while preserving planner-produced repository and
pull-request configuration, task reasoning/goal settings, and Markdown report materialization. A
small closer model reports the final task outcome for both OpenCompany and Codex turns, reusing the
shared `update_task_status` schema without exposing that tool to normal step execution.

Workflows are sequences of ordinary durable turns. When a step reports `done`, settlement
atomically appends the next step's handoff user message and assistant placeholder, enqueues the next
turn, and switches the session engine/model to that step's compiled values. `needs_attention`,
failure, or interruption halts the workflow. Current step state remains on the task projection.

## Google Tools

Entry points:

- `apps/goat/lib/capabilities/google-calendar.ts`
- `packages/goat-agent/src/actions/catalog.ts`
- `packages/goat-agent/src/actions/execute.ts`
- `packages/db/src/goat-integrations.ts`

Foreground chat runs Google Calendar through the capability worker. The Calendar capability keeps
read, create, and write tool surfaces separate, resolves only the current user's connected
accounts, refreshes encrypted OAuth credentials server-side, and requires an explicit account when
more than one is connected. Create and write calls are scope-gated and limited to a single mutation
attempt without attendee notifications. Background OpenCompany tasks use the same connected action
catalog as chat rather than a separate runner-only Google implementation.

## Data Model

Goat-specific tables live in `packages/db/src/goat-schema.ts`.

Important tables:

- `goat.users`: WorkOS-backed Goat user profile, including the off-by-default
  `task_spawning_enabled` and `auto_model_routing_enabled` feature flags.
- `goat.chat_sessions`: one open or closed thread per user. `kind` distinguishes ordinary chats
  from task sessions without changing their message or execution model.
- `goat.chat_messages`: persisted user and assistant chat messages. Assistant messages can point
  at a `taskId` so the UI can render a task card. Task completion notifications are also persisted
  here as synthetic assistant messages.
- `goat.chat_session_skills`: immutable skill snapshots activated by user messages. A snapshot
  remains available for the rest of that chat even if its source Brain changes or is deleted.
- `goat.codex_chat_sessions`: durable engine runtime state. Codex/Claude Code rows include their
  persistent sandbox and engine thread/session; OpenCompany rows leave those fields null. All rows
  track the active turn, status, pinned Brain, and workspace.
- `goat.codex_chat_turns`: leased, per-session-FIFO durable chat turn queue and message linkage for
  all three engines (the legacy table name is intentionally retained).
- `goat.codex_chat_interactions`: pending/resolved/canceled server-initiated requests and responses.
- `goat.codex_chat_events`: normalized persistent cloud coding event audit rows.
- `goat.repo_configs`: workspace-scoped repository setup instructions, masked env key names, and
  encrypted environment-file payloads used by Codex and Claude Code chat sandboxes.
- `goat.tasks`: thin task projection linked to a chat through `session_id`, with status, stage,
  result/outcome, workflow/schedule metadata, board fields, and the current compiled harness.
- `goat.task_messages` and `goat.task_events`: legacy compatibility history. New tasks never write
  them.
- `goat.integrations`: connected Gmail, Google Calendar, and Linear accounts.
- `goat.integration_credentials`: encrypted OAuth token payloads.

Task state is deliberately simple:

```text
queued -> running/planning -> running/running
  -> succeeded/completed
  -> failed/failed
terminal task + user reply -> queued
```

The UI maps this projection to Tasks rows while task detail renders the linked chat session
natively. Goat task pages subscribe to `goat.tasks` plus the standard session messages and runtime
state. Legacy rows without a session still subscribe to `goat.task_messages` and `goat.task_events`
for read compatibility. Origin chats subscribe to `goat.chat_messages`, so task completion
notifications appear without a manual refresh.

Settings and Brain use the same pattern for `goat.integrations`, `goat.brain_folders`, and
`goat.brain_documents`. Server props are initial render fallbacks; after hydration, live Electric
rows are the source of truth for persisted Goat state.

## Company bootstrap imports

Brain bootstrap imports deliberately separate discovery from model ingestion:

1. An admin supplies the public company origin, optional focus, and source scopes. The runner
   scans a fixed 30-day window, reuses normalized source items, hydrates up to 20 recent Granola
   notes or Fathom meetings when those sources are selected, and performs a bounded public search
   (at most eight searches and 40 canonical results). Discovery persists candidates with no target brain, so it cannot
   enqueue an ingestion model.
2. The UI displays provider totals, already-known entries, selected windows, and the exact number
   of planned ingestion runs. The count includes one cached public-research bundle when present
   and one final organization pass. Only explicit confirmation creates child jobs.
3. Confirmed jobs run through the normal per-brain ingest lock. Import jobs carry
   `import_run_id` through document versions and disable incidental live-web enrichment, keeping
   the confirmed workload bounded. Connected source scopes are also saved as ongoing Brain
   sources.
4. The import worker polls child jobs without holding its lease. The finalizer runs only after all
   children are terminal and may merge duplicates, repair backlinks, and run health checks, but it
   may not add new claims or uncited sources. Mixed outcomes end as `partial`; completed documents
   remain available.

Cancellation before confirmation does no model work. During ingestion it skips queued children,
lets a running child finish safely, and prevents finalization. Import candidates are intentionally
not exposed through Electric; only the aggregate `brain_import_runs` row is brain-scoped for live
progress. Provenance is recorded now so a later undo flow can identify affected versions without
reconstructing history.

## Relationship To The Full Agent Runtime

The full OpenCompany agent runner is documented in root docs and lives mostly in `apps/runner/src`.
Key files:

- `docs/agent-file.md`
- `docs/agent-turn-vocabulary.md`
- `docs/stack/ai-and-agent-runtime.md`
- `apps/runner/src/agent-loop.ts`
- `apps/runner/src/session-lifecycle.ts`
- `apps/runner/src/delegation.ts`
- `apps/runner/src/tool-dispatcher.ts`

That path works differently from Goat tasks:

- Sessions are rows in `agent_sessions`.
- The runtime config is compiled from a `.agent` file plus bundle context.
- `runMessage` answers one user message per lease and loops over queued steering messages.
- `resolveAgentRuntimeConfig` builds the system prompt and enabled runtime tools.
- `ensureSandbox` creates/connects E2B and prepares a real workspace layout.
- The sandbox may materialize Brain files, agent bundle files, skills, and attachments.
- `createToolSet` exposes hosted tools, sandbox tools, MCP tools, coding-agent tools, and
  delegation tools.
- `delegate_to_agent` creates inspectable child sessions for referenced workspace agents.
- Runs can suspend for approvals, user questions, or child-agent waits.
- Brain and agent bundle changes are synced back after turns.

In other words, the current Goat task harness is a small specialized LLM worker. The full runner is
the general multi-agent substrate.

## What "Multi-Agent" Means Today

For Goat specifically, there are multiple LLM roles but not yet multiple durable agents:

- Foreground chat model: triages the user's input and may start a task.
- Harness planner model: selects the execution harness spec.
- Harness execution model: performs the task with tools.
- Runner-hosted tools: execute private Google API calls and Exa search in the runner process.

For the broader platform, multi-agent means actual nested agent sessions:

- `.agent` files can reference other agents.
- The parent model gets `delegate_to_agent`.
- Delegation creates child sessions with their own leases, model turns, tools, sandbox state, and
  transcript.
- Parent sessions can await child completion and receive child results.

Goat does not currently expose that parent/child session model in its app surface.

## Tweak Points

Common changes and where they belong:

- Change when chat starts a task: `createOpenCompanyChatSystemPrompt` in
  `apps/goat/lib/prompts/main-chat.ts` and `createOpenCompanyChatToolContext` in
  `apps/goat/lib/chat-agent.ts`.
- Change lightweight chat web access: `web_fetch`/`web_search` in
  `apps/goat/lib/chat-agent.ts` and their Exa callbacks in `apps/goat/app/api/chat/route.ts`.
- Change managed chat capabilities: the endpoint allowlist and validators in
  `apps/goat/lib/capabilities/catalog.ts`, execution policy in
  `apps/goat/lib/capabilities/execute.ts`, and workspace controls in
  `apps/goat/app/(app)/settings/workspace/capabilities`.
- Change chat streaming behavior: `apps/goat/app/api/chat/route.ts` and
  `apps/goat/components/GoatSurface.tsx`.
- Change task creation defaults: `createGoatTaskForUser` in `apps/goat/lib/tasks.ts`.
- Change runner dispatch: `apps/goat/lib/task-runner.ts` and the Goat route in
  `apps/runner/src/server.ts`.
- Change planner behavior or harness spec schema: `planGoatHarnessForTask` in
  `apps/runner/src/goat-harness.ts` and prompt blocks in
  `apps/runner/src/prompts/goat-harness-creation.ts`.
- Change Goat Codex subscription auth: `apps/goat/lib/codex-auth.ts`,
  `apps/runner/src/codex-auth.ts`, and `packages/db/src/goat-codex-auth.ts`.
- Change Goat Codex execution: `apps/runner/src/goat-codex.ts`.
- Add or change shared chat/task tools: `packages/goat-agent/src/chat-agent.ts` and the Goat app or
  runner callbacks passed into `createOpenCompanyChatToolContext`.
- Change the task model loop: `executeGoatTask` in `apps/runner/src/goat-harness.ts` and
  `runGoatTaskChatLoop` in `apps/runner/src/goat-task-chat-loop.ts`.
- Move Goat onto full multi-agent sessions: start from `apps/runner/src/agent-loop.ts`,
  `apps/runner/src/session-lifecycle.ts`, `apps/runner/src/delegation.ts`, and
  `docs/agent-file.md`.

## Current Constraints And Risks

- Direct chat is not durable beyond persisted messages. It does not use runner leases.
- Goat tasks are text-result only. They do not persist files or artifacts from task tools.
- Gateway and Exa keys are used in the Goat route and runner process. Google credentials stay
  server-side.
- Debug traces can contain prompts, tool arguments, snippets, and truncated private Google results.
  Treat them as sensitive application data.
- The task worker reclaims expired running work, but failed tasks are terminal unless a future
  feature explicitly requeues them.
- Goat's current harness has no built-in child-agent delegation. Adding true multi-agent behavior
  means either adopting the full agent session runner or designing a task-local child-agent model.
