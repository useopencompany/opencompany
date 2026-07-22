# Goat LLM System

This is the current-state map of how Goat answers chat messages and runs durable LLM tasks. It is
intended as a baseline before changing the system.

For the Brain (Goat's knowledge store — data model, ingestion, tools, contracts), see the
[brain section](./brain/README.md).

## Current Shape

Goat has four LLM paths:

1. **Foreground chat:** a short-lived AI SDK stream from the browser to `apps/goat/app/api/chat`.
   This agent answers directly, calls `goat_brain`, or calls `start_task`.
2. **Background task:** a durable row in `goat.tasks` whose transcript is a linked
   `goat.chat_sessions` conversation. OpenCompany tasks are claimed by `apps/runner` and executed
   by the task-session driver; Codex tasks are queued through the Cloud Codex chat worker.
3. **Local Codex chat:** a Goat chat engine mode that queues commands for a user-run local bridge.
   The bridge creates a clean session folder under `~/.opencompany/goat/sessions`, runs
   `codex app-server`, and posts normalized Codex events back into the Goat chat.
4. **Cloud Codex chat:** a Goat chat engine mode backed by a persistent E2B sandbox and Codex
   app-server thread. Uploaded images, PDFs, Word files, and Excel files are materialized into that
   sandbox; images are also sent to Codex as native local-image inputs.

The Goat task path is a chat session, not a full OpenCompany `.agent` session. It reuses runner
infrastructure, Vercel AI Gateway, leases, observability, Brain access, and server-side tools, but
does not use `agent_sessions`, `.agent` files, approvals, or `delegate_to_agent`.

The wider OpenCompany runner has a separate full multi-agent session loop.

## High-Level Flow

```text
Browser
  GoatSurface useChat()
    POST /api/chat
      persist user chat message
      streamText(default Goat chat agent)
        answer directly
        OR call goat_brain
        OR, when Background tasks is enabled in Preferences, call start_task
          insert goat.tasks row
          POST /internal/goat/tasks/:taskId/run
    OR Local Codex mode
      POST /api/local-codex/messages
        enqueue local Codex bridge command
    OR Cloud Codex mode
      POST /api/codex-chat/messages
        persist the message and attachment metadata
        enqueue a turn for the cloud Codex chat worker

Runner
  Goat task worker wakes/polls
    claim queued task with lease
    load the deterministic task chat session
    streamText with the shared Goat chat agent prompt and task tools
      persist user, assistant, and steering turns in goat.chat_messages
      persist status and result entries in goat.task_comments
    use final assistant text as the task result
    mark task succeeded, failed, or canceled

Goat UI
  subscribes to Electric task, chat, Cloud Codex, and local Codex shapes
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

The composer can attach eligible pages from the active Brain's protected `skills/` folder with
`@skill/<id>`. The visible token is paired with structured `{ kind: "skill", brainRef, id }`
metadata; manually typed lookalikes stay plain text. The server resolves that metadata again under
the current user's active-Brain access, rejects stale or cross-Brain references, and caps a turn at
16 skills / 256 KiB of canonical `SKILL.md` content. The first valid mention stores an immutable
snapshot in `goat.chat_session_skills`; re-mentioning the same id keeps that session's original
version.

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

## `/api/chat`

`POST /api/chat` does the foreground work:

1. Authenticates the current Goat user.
2. Parses and validates the submitted UI message, model, and optional session id.
3. Requires `VERCEL_AI_GATEWAY_API_KEY`.
4. Finds or creates an open `goat.chat_sessions` row.
5. Persists the user message in `goat.chat_messages`.
6. Creates the chat tool context for `start_task`, `goat_brain`, and optional `web_search`.
7. Calls `streamText` through Vercel AI Gateway with the selected model.
8. Streams the UI message response back to the browser.
9. Persists the assistant message, debug trace, and optional task link on finish.

When a background task that was started from chat succeeds or fails, the runner appends a synthetic
assistant message to the originating chat session if that session is still open. The message includes
the task link and final result or error so the next user reply has the completed task in context.
This is only a persisted notification; Goat does not automatically spend another foreground chat
model turn when the task finishes.

The chat agent's system prompt is built by `createOpenCompanyChatSystemPrompt`, assembled from
structured blocks in `apps/goat/lib/prompts/main-chat.ts`. The route injects runtime context such as
the current date and a compact DB-backed `user_context` profile with the user's name, email, and
timezone. `goat_brain` is always available and `web_search` is available when Exa is configured.
Connected chat capabilities are dispatched through `use_capability` with an explicit operation:
`read` for retrieval, or an advertised `create` or `write` for mutations. Slack and YouTube remain
read-only. Linear advertises `write`; its read calls receive only read tools, while an explicitly
requested write call additionally receives bounded `create_issue` access. Attio advertises read
access for available standard records, interaction-recency queries, workspace lists and their
entries, and notes. It advertises scope-dependent `create` access for standard people, companies,
enabled deals, and notes, with one successful creation per call. Google Calendar advertises `create`
and `write` only for accounts connected with the `calendar.events` scope. Calendar read workers can
list events and free/busy
windows; create workers receive one event-create tool, while write workers receive event-update and
event-delete tools. A Calendar worker can make at most one mutation attempt and never changes
attendees or sends invitations. Existing read-only Calendar connections must be reconnected before
the mutation operations are advertised by using **Reconnect or add** and selecting the same Google
account. Linear updates, comments, deletes, and every other unlisted mutation remain unavailable, as
do Attio updates and deletes.
`start_task` and the recurring schedule tools, prompt guidance, schedule context, background-task
rows, routines, and runner claims are enabled only when the user opts into **Background tasks** in
Preferences. The unified Tasks section itself remains available for Cloud Codex sessions. The
database flag defaults off, so the standard Goat experience is chat plus Brain without background
task spawning. Tool descriptions live in `apps/goat/lib/prompts/tool-descriptions.ts`.

The default chat model is `anthropic/claude-sonnet-5`. New tasks store the chat-selected model at
creation time, then the runner planner chooses the task execution model from its allowed model
catalog and writes that planned model back to the task row.

Important runtime settings:

- `maxOutputTokens: 900`
- `stopWhen: stepCountIs(8)`
- `abortSignal: request.signal`

The chat path is a normal request/response stream. It has no runner lease or durable retry. The
durable boundary starts only when `start_task` creates a task row.

Brain skills are user-authored, session-scoped context. Normal chat replays each immutable skill
snapshot on the historical user message that activated it, so the full instructions remain in model
history on later turns while visible chat content stays unchanged. Cloud Codex materializes every
snapshot under `.agents/skills/<id>/SKILL.md` and sends newly activated skills to app-server as
native `skill` inputs; Codex then keeps invoked instructions in its persistent thread. Skills are
unavailable in Local Codex and are not copied into background, delegated, or recurring tasks.

## Local Codex Chat

Entry points:

- `apps/goat/components/GoatSurface.tsx`
- `apps/goat/app/api/local-codex/*`
- `apps/goat/lib/local-codex.ts`
- `apps/goat-local-bridge/src/index.ts`
- `packages/agent-runtime/src/codex-app-server-events.ts`

`Local Codex` is a beta-gated composer engine mode, not a normal model id. Users enable the `Local
Codex bridge` beta in Goat Settings before the picker option, pairing API, message API, or bridge
token APIs are available. First messages do not need a repo path for the MVP. Goat persists a
`local_codex` chat session, creates user and assistant chat rows, and queues a `start_turn` command
for the most recent active bridge for that user. The bridge starts Codex in a new local session
folder at `~/.opencompany/goat/sessions/<session-id>`.

In local development, `bun run dev:goat` starts the bridge launcher as part of the Turbo dev stack.
The launcher waits until the selected Goat user has enabled the `Local Codex bridge` beta, then
creates or reuses a gitignored token at
`.context/goat-local-bridge/dev-token.json` for the most recent Goat user, waits for the Goat app,
then runs the bridge against `http://127.0.0.1:3002` by default. Set
`GOAT_LOCAL_BRIDGE_DISABLED=1` to skip this, or `GOAT_LOCAL_BRIDGE_USER_WORKOS_ID` to pin the dev
bridge to a specific local user.

Goat creates `~/.opencompany/goat/projects` as the managed project clone folder during local bridge
startup for future repo-open flows. For the current MVP, Local Codex sessions start in empty
per-session folders. Set `GOAT_LOCAL_PROJECTS_DIR` to use a different managed folder.

The local bridge authenticates with a bridge token, long-polls
`/api/local-codex/bridge/commands`, and acknowledges each command after it has called Codex
app-server. It launches Codex app-server with `--dangerously-bypass-approvals-and-sandbox` and
`shell_environment_policy.inherit=all`, so local sessions run with the user's local machine
permissions and inherited environment. Existing local GitHub auth, SSH agent, git credential helper,
and `gh` auth should be available to the session. When a command includes a repo path, it validates
that repo paths are absolute Git repos under `$HOME`, creates detached tracked-HEAD worktrees only,
and never copies dirty changes or edits the original repo checkout. Commands without a repo path use
a clean session folder instead.

Codex app-server notifications are normalized in `@opencompany/agent-runtime` before Goat stores
them in `goat.local_codex_events`. Assistant deltas are persisted as raw events, but Goat only
writes the assistant chat text from completed assistant messages so the UI does not stream token by
token. Command, reasoning, error, and turn lifecycle events append compact activity text. The chat UI
subscribes to `goat.chat_messages` and `goat.local_codex_sessions` through Electric so local Codex
output and running/interrupt state update live.

While a local Codex turn is running, the composer stays enabled. Submitting more text queues
`turn/steer`; the dedicated stop control queues `turn/interrupt`.

Local Codex does not expose the Plan control yet. The bridge recognizes server-initiated
app-server requests and returns an explicit unsupported-request error instead of silently treating
them as client responses, but its command-polling transport does not yet have a durable path for a
browser answer to reach the blocked local process.

## Cloud Codex Chat

Entry points:

- `apps/goat/components/GoatSurface.tsx`
- `apps/goat/app/api/codex-chat/*`
- `apps/goat/lib/codex-chat.ts`
- `apps/runner/src/goat-codex-chat.ts`
- `apps/runner/src/codex-app-server.ts`

Cloud Codex uses a persistent sandbox per Goat chat and resumes the same Codex app-server thread on
follow-up turns. New turns remain `queued` until the runner claims them, then move through
`starting` and `running`; the worker uses the runner-wide concurrency setting rather than a
Cloud-Codex-specific limit. The composer accepts the same private-blob uploads as normal Goat chat.
At run time, the worker downloads the current turn's files into
`~/.opencompany-goat/codex-chat-attachments/<turn-id>/` and includes those paths in the user task.
Image uploads are additionally passed to `turn/start` as `localImage` inputs, so screenshots are
visible to the model rather than merely path-referenced. Keeping uploads outside the working
directory prevents them from appearing in repository changes.

The Codex app-server daemon runs behind its Unix-socket control transport inside E2B and outlives
the runner-side proxy. A runner shutdown detaches that proxy, releases the delivery lease, and lets
the next worker `thread/resume` the same stored Codex turn id. The reconnect reconciles completed
items and a terminal turn that landed while no runner was attached; stable per-item event keys make
that replay idempotent. Lease claims count infrastructure ownership changes, while
`recovery_attempts` increments only when the original Codex turn is missing or was interrupted and
the worker must start one guarded continuation. A dead proxy with a pending user-input request
forces that guarded continuation because server-initiated requests cannot move between client
connections.

Session skills are reconciled before every Cloud Codex turn under
`/home/user/opencompany-goat/codex-chat/.agents/skills/`. The managed-skills manifest removes only
OpenCompany-managed ids and preserves any unrelated native skills. A content fingerprint restarts
the app-server daemon when the installed set changes, while the persistent Codex thread is resumed.
Only skills whose first activation belongs to the current turn are included as native `skill`
inputs; previously activated skills remain installed and in thread history.

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

On the Goat home, open Cloud Codex sessions are projected into the unified Tasks section alongside
background `goat.tasks`. This is a live UI projection of the chat-backed session and its
`goat.codex_chat_sessions` runtime state, not a copied task row: selecting it still opens
`/chat/<session-id>`, pinning and archiving keep their chat semantics, and the sidebar continues to
show it in conversation history. Local Codex remains a chat-only surface.

## Task Creation

Entry points:

- `apps/goat/lib/tasks.ts`
- `apps/goat/lib/task-runner.ts`

`createGoatTaskForUser` creates the task row. It:

- Generates a `goat_task_*` id.
- Normalizes a short display name.
- Inserts `goat.tasks` with `status: "queued"` and `nextRunAt: now`.
- Creates a deterministic run session using `goatTaskRunSessionId(taskId)` and inserts the opening
  user message into `goat.chat_messages` in the same transaction.
- For Codex tasks, also creates the Cloud Codex session, assistant placeholder, and queued turn.
- Best-effort dispatches the runner through `triggerGoatTaskRun`.

`triggerGoatTaskRun` calls:

```text
POST {RUNNER_INTERNAL_URL}/internal/goat/tasks/:taskId/run
Authorization: Bearer {RUNNER_INTERNAL_TOKEN}
```

If the runner URL or token is missing, the task stays queued for polling.

## Runner Worker

Entry points:

- `apps/runner/src/index.ts`
- `apps/runner/src/server.ts`
- `apps/runner/src/goat-worker.ts`
- `apps/runner/src/goat-task-session.ts`

The runner process starts a normal session job worker and a Goat task worker. The HTTP route
`/internal/goat/tasks/:taskId/run` does not claim that exact task directly. It authenticates the
internal token, logs the accepted request, and wakes the in-process Goat worker.

The worker loop:

- Polls roughly every second by default.
- Runs with bounded concurrency, defaulting to `min(2, env.workerConcurrency)`.
- Claims the next eligible task using `FOR UPDATE SKIP LOCKED`.
- Reclaims `running` tasks whose lease has expired.
- Sets `status: "running"`, increments `attempts`, and writes a lease id, lease owner, and lease
  expiry.
- Heartbeats every 5 seconds while the executor runs.
- Aborts the model stream if the lease is lost.
- Ensures the deterministic run session and opening message exist for crash recovery.
- Drains steering messages as additional turns in the same conversation.

On success it writes:

- `status: "succeeded"`
- `result`, copied from the final assistant chat message
- a result row in `goat.task_comments`

On failure it writes:

- `status: "failed"`
- `error`
- a failed status row in `goat.task_comments`

On user stop it writes:

- `status: "canceled"`
- `error: "Stopped by user."`
- clears the active lease
- a canceled status row in `goat.task_comments`

The task transcript lives only in `goat.chat_messages`. Model, hosted-tool, and sandbox costs remain
in the task usage tables. The task detail UI reads the `goat.tasks` row and `goat.task_comments`
through Electric and links to the run session for the full transcript and steering.

Failed and canceled tasks are not automatically retried by this worker. Only stale `running` tasks are reclaimed.

## Task Session Execution

Entry points:

- `apps/runner/src/goat-task-session.ts`
- `apps/runner/src/goat-tools.ts`
- `apps/runner/src/goat-google-tools.ts`
- `packages/goat-agent`

OpenCompany tasks call AI SDK `streamText` in the runner process. The driver:

1. Loads the linked chat transcript and appends a recoverable continuation instruction when needed.
2. Uses the shared Goat chat system prompt and tool context from `packages/goat-agent`.
3. Streams each assistant turn into `goat.chat_messages` on a short throttle.
4. Records model, hosted-tool, and sandbox usage against the task lease.
5. Drains queued steering messages into follow-up turns.
6. Completes with the trimmed final assistant content and mirrors it to `goat.tasks.result`.

If the final assistant content is empty, the task fails. There is no `goat_result` tool.

Available task tools are resolved from the user's integrations and runtime configuration, including:

- `exa_search`: runs in the runner process against Exa.
- `gmail_search`
- `gmail_get_message`
- `gmail_list_threads`
- `gmail_get_thread`
- `calendar_list_calendars`
- `calendar_list_events`
- `calendar_get_event`
- `calendar_get_freebusy`
- `linear_search_tools`
- `linear_use_tool`
- Brain read/save tools.
- GitHub and browser tools when their runtime dependencies are available.
- Google tools run server-side in the runner and resolve encrypted OAuth credentials from the
  database. The authenticated `/goat/tools/:taskId` endpoint remains available to Codex sandboxes.

Codex tasks use the Cloud Codex chat worker. `goat-codex-task-settle.ts` mirrors the terminal turn
onto the task row and activity feed after no queued or running steering turn remains.

## Google Tools

Entry points:

- `apps/goat/lib/capabilities/google-calendar.ts`
- `apps/runner/src/goat-google-tools.ts`
- `packages/db/src/goat-integrations.ts`

Foreground chat runs Google Calendar through the capability worker. The Calendar capability keeps
read, create, and write tool surfaces separate, resolves only the current user's connected
accounts, refreshes encrypted OAuth credentials server-side, and requires an explicit account when
more than one is connected. Create and write calls are scope-gated and limited to a single mutation
attempt without attendee notifications.

Durable background tasks continue to use the runner's read-only Gmail and Calendar tools. The
runner:

1. Checks the tool name is known.
2. Resolves the user's connected account.
3. Loads encrypted OAuth credentials from the database.
4. Refreshes the access token when needed.
5. Calls the Google API server-side.
6. Returns sanitized JSON output to the task model.

If Google rejects a refresh token, the integration is marked `needs_reauth`.

## Data Model

Goat-specific tables live in `packages/db/src/goat-schema.ts`.

Important tables:

- `goat.users`: WorkOS-backed Goat user profile, including the off-by-default
  `task_spawning_enabled` feature flag and the `local_codex_beta_enabled` beta flag.
- `goat.chat_sessions`: one open or closed chat thread per user.
- `goat.chat_messages`: persisted user and assistant chat messages. Assistant messages can point
  at a `taskId` so the UI can render a task card. Task completion notifications are also persisted
  here as synthetic assistant messages.
- `goat.chat_session_skills`: immutable skill snapshots activated by user messages. A snapshot
  remains available for the rest of that chat even if its source Brain changes or is deleted.
- `goat.local_bridges`: paired local Codex bridge records with hashed tokens and heartbeat state.
- `goat.local_codex_sessions`: per-chat local Codex runtime metadata such as repo path, worktree
  path, Codex thread id, active turn, status, and error.
- `goat.local_codex_turns`: local Codex user and assistant message linkage plus Codex turn status.
- `goat.local_codex_commands`: queued bridge commands for start, steer, interrupt, and close.
- `goat.local_codex_events`: raw app-server notifications plus normalized event type and payload.
- `goat.codex_chat_sessions`: persistent cloud sandbox, app-server thread, active turn, and status.
- `goat.codex_chat_turns`: leased Cloud Codex turn queue and message linkage.
- `goat.codex_chat_interactions`: pending/resolved/canceled server-initiated requests and responses.
- `goat.codex_chat_events`: normalized Cloud Codex event audit rows.
- `goat.tasks`: durable background task queue, engine, status, result, error, schedule linkage, and
  lease state.
- `goat.task_comments`: status, result, and comment activity for task detail pages.
- `goat.task_model_usage`, `goat.task_tool_usage`, and `goat.task_sandbox_usage`: per-task cost and
  usage records whose message pointers refer to the linked chat transcript without foreign keys.
- `goat.integrations`: connected Gmail, Google Calendar, and Linear accounts.
- `goat.integration_credentials`: encrypted OAuth token payloads.

Task state is deliberately simple:

```text
queued -> running -> succeeded
                  -> failed
       -> canceled
```

The UI maps this to Tasks rows and task detail pages. Goat task pages subscribe to TanStack DB
collections backed by Electric shapes for `goat.tasks` and `goat.task_comments`, scoped by
`user_workos_id`. Opening the deterministic run session subscribes to its `goat.chat_messages`
shape and enables steering. The active origin chat also receives persisted task completion
notifications without a manual refresh.

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

That path remains distinct from Goat task chat sessions:

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

The Goat task-session driver is a specialized single-agent worker. The full runner is the general
multi-agent substrate.

## What "Multi-Agent" Means Today

For Goat specifically, there are multiple execution surfaces but not yet multiple durable agents:

- Foreground chat model: triages the user's input and may start a task.
- OpenCompany task-session model: performs the task with shared Goat prompts and tools.
- Cloud Codex task session: performs Codex-engine tasks through the Codex app-server worker.
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
- Change lightweight chat web search: `web_search` in `apps/goat/lib/chat-agent.ts` and the Exa
  callback in `apps/goat/app/api/chat/route.ts`.
- Change chat streaming behavior: `apps/goat/app/api/chat/route.ts` and
  `apps/goat/components/GoatSurface.tsx`.
- Change task creation defaults: `createGoatTaskForUser` in `apps/goat/lib/tasks.ts`.
- Change runner dispatch: `apps/goat/lib/task-runner.ts` and the Goat route in
  `apps/runner/src/server.ts`.
- Change Goat Codex subscription auth: `apps/goat/lib/codex-auth.ts`,
  `apps/runner/src/codex-auth.ts`, and `packages/db/src/goat-codex-auth.ts`.
- Change Goat Codex execution: `apps/runner/src/goat-codex-chat.ts` and
  `apps/runner/src/goat-codex-task-settle.ts`.
- Change the OpenCompany task prompt or agent tools: `packages/goat-agent` and
  `apps/runner/src/goat-task-session.ts`.
- Add or change sandbox-facing task tools: `apps/runner/src/goat-tools.ts`, implementation files like
  `apps/runner/src/goat-google-tools.ts`, and `GoatTaskToolName` in
  `packages/db/src/goat-schema.ts`.
- Change the task model loop: `runClaimedGoatTaskSession` in
  `apps/runner/src/goat-task-session.ts`.
- Move Goat tasks onto full multi-agent sessions: start from `apps/runner/src/agent-loop.ts`,
  `apps/runner/src/session-lifecycle.ts`, `apps/runner/src/delegation.ts`, and
  `docs/agent-file.md`.

## Current Constraints And Risks

- Direct chat is not durable beyond persisted messages. It does not use runner leases.
- Goat tasks are text-result only. They do not persist files or artifacts from task tools.
- Gateway and Exa keys are used in the Goat route and runner process. Google credentials stay
  server-side.
- Chat message debug traces can contain prompts, tool arguments, snippets, and truncated private
  results. Treat them as sensitive application data.
- The task worker reclaims expired running work, but failed tasks are terminal unless a future
  feature explicitly requeues them.
- Goat's task-session driver has no built-in child-agent delegation. Adding true multi-agent behavior
  means either adopting the full agent session runner or designing a task-local child-agent model.
