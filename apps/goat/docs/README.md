# Goat LLM System

This is the current-state map of how Goat answers chat messages and runs durable LLM tasks. It is
intended as a baseline before changing the system.

For the Brain (Goat's knowledge store — data model, ingestion, tools, contracts), see the
[brain section](./brain/README.md).

## Current Shape

Goat has four LLM paths:

1. **Foreground chat:** a short-lived AI SDK stream from the browser to `apps/goat/app/api/chat`.
   This agent answers directly, reads connected integrations, calls `goat_brain`, captures with
   `save_to_brain`, or calls `start_task`.
2. **Background task:** a durable row in `goat.tasks` claimed by `apps/runner`, planned into a
   `goat.harness.v1` config, then executed by an AI SDK model loop in the runner process.
3. **Local Codex chat:** a Goat chat engine mode that queues commands for a user-run local bridge.
   The bridge creates a clean session folder under `~/.opencompany/goat/sessions`, runs
   `codex app-server`, and posts normalized Codex events back into the Goat chat.
4. **Cloud Codex chat:** a Goat chat engine mode backed by a persistent E2B sandbox and Codex
   app-server thread. Uploaded images, PDFs, Word files, Excel files, and SRT subtitles are
   materialized into that sandbox; images are also sent to Codex as native local-image inputs. New
   chats pin the active Brain and expose its read plane through a runner-hosted Codex dynamic tool.

The Goat task path is not currently a full OpenCompany `.agent` session. It reuses runner
infrastructure, Vercel AI Gateway, leases, observability, and server-side tools, but it
does not yet use `agent_sessions`, `.agent` files, Brain mounts, skills, approvals, or
`delegate_to_agent`. It does expose selected user-scoped MCP integrations through the Goat
task harness, starting with Linear.

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
    plan harness spec with Gateway planner model
    create durable assistant task message
    streamText with Gateway, Exa, Gmail, Calendar, and Linear MCP tools
      append durable message and tool events
    use final assistant message as the task result
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
metadata. Exact skill tokens pasted into the composer are resolved against the active Brain catalog,
while manually typed lookalikes stay plain text. The server resolves that metadata again under the
current user's active-Brain access, rejects stale or cross-Brain references, and caps a turn at 16
skills / 256 KiB of canonical `SKILL.md` content. The first valid mention stores an immutable snapshot
in `goat.chat_session_skills`; re-mentioning the same id keeps that session's original version.

Normal main chat can also discover Brain skills progressively. When the catalog is non-empty, the
system prompt advertises only that a skill source exists; `list_skills` searches safe id, name, and
description metadata, and `use_skill` loads the full instructions for one exact returned id. The
successful tool result stays in conversation history, so model-selected skill instructions remain
available on later turns without being copied into the system prompt or delegated tasks. Explicit
and model-selected skills share the same per-turn limit of 16 skills / 256 KiB of instructions.

The composer also accepts PDF, DOCX, XLSX, SRT, PNG, JPEG, and WebP files. SRT MIME values are
normalized because browsers report them inconsistently. Foreground chat stores bounded extracted
SRT text for the initial and follow-up turns; Cloud Codex receives the original file in its sandbox.

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
6. Resolves active-Brain skills, connected-integration actions, and the workspace's managed
   social/lead capabilities, then creates the chat tool context for `goat_brain`, `save_to_brain`,
   `list_skills`/`use_skill`, `list_actions`/`use_action`, optional `start_task`, and optional
   `web_fetch`/`web_search`.
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
exposes file search, live Google Doc reads, and exact text replacement in Google Docs. Linear exposes
a curated catalog for reading issues and workspace context, creating and updating issues, and adding
comments. Attio exposes bounded fuzzy search across standard people, companies, and deals; list,
field, and membership discovery; and bounded list reads with saved-view filters, explicit filters,
sorting, and pagination. Explicitly requested Gmail sends, Google Doc edits, Attio record and
list-entry updates, Linear writes, and Google Calendar event creation require confirmation by default
and can be configured under Integrations. An explicit account or workspace is required when several
are connected. Stripe exposes read-only workspace metrics for balance activity by period, current
balances, subscription health with estimated MRR, and open receivables. Stripe uses an encrypted
restricted API key and is excluded from automatic Brain-fill surveying because those financial
metrics are live operational state. Disconnected or disabled capabilities are absent from the
catalog, guessed action ids cannot bypass it, and all provider credentials remain server-side.
Deeper or multi-source connected-account work continues through background tasks.

Managed X, LinkedIn, YouTube, Instagram, TikTok, prospecting, and Semrush SEO actions use a fixed
server-to-server endpoint allowlist in `apps/goat/lib/capabilities/catalog.ts`. Prospecting includes
bounded PDL person search across current title and seniority, person or company location, company
industry, provider-estimated company employee count, and work-email availability, plus focused
enrichment actions. Every paid execution inspects its live endpoint schema and price before running,
checks shared workspace credits, and requires a one-time approval above the per-action or per-turn
thresholds. Provider data is treated as hostile input, redacted and bounded before it enters the chat
trace, and billed once from the settled provider cost plus the platform fee. The durable
`goat.capability_runs` row stores only the parameter hash and lifecycle/cost metadata; only the
safety-bounded action result enters the requesting chat. The hourly billing reconciler settles
interrupted or delayed runs.
YouTube transcript search fetches one full timestamped transcript through a reviewed Monid-backed
Apify actor, searches it server-side for the requested phrase, and returns only bounded timestamped
context windows to the chat.
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
the worker must start one guarded continuation. Persisting the replacement Codex turn id rearms
that guard for the new engine turn, so long-running chats can survive repeated deploys without
allowing two continuations for the same missing turn. A dead proxy with a pending user-input
request forces that guarded continuation because server-initiated requests cannot move between
client connections.

Session skills are reconciled before every Cloud Codex turn under
`/home/user/opencompany-goat/codex-chat/.agents/skills/`. The managed-skills manifest removes only
OpenCompany-managed ids and preserves any unrelated native skills. A content fingerprint restarts
the app-server daemon when the installed set changes, while the persistent Codex thread is resumed.
Only skills whose first activation belongs to the current turn are included as native `skill`
inputs; previously activated skills remain installed and in thread history.

New Cloud Codex chats pin the user's active Brain and workspace on `goat.codex_chat_sessions`
together with the host-tool contract version used to start the Codex thread. On `thread/start`, the
runner registers the read-only `goat_brain`, `list_actions`, and `use_action` functions through
app-server's experimental `dynamicTools` API. When Codex sends `item/tool/call`, the runner handles
Brain reads directly or calls Goat's private action gateway with `RUNNER_INTERNAL_TOKEN`.

The action gateway derives the user and workspace from the running turn, rechecks current workspace
membership, resolves current connections and permission settings, and exposes only integration
actions whose capability is `read` and permission mode is `on`. Writes, confirmation-gated actions,
and paid managed capabilities are not present in the Cloud Codex catalog. Provider credentials,
the internal bearer, and database access never enter E2B. A per-turn call budget bounds provider
reads.

Because app-server stores dynamic tool definitions on the thread, resumed turns provide the
matching runner callbacks without trying to redefine the tools. Existing Brain-tool v1 sessions
remain Brain-only. The Brain contract intentionally supports only `query`, `list`, `get`, and
`timeline`; it cannot write to the Brain.

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
Pending dynamic host-tool calls also force a guarded recovery, since their result belongs to the
runner proxy connection that received the original request.

On the Goat home, open Cloud Codex sessions are projected into the unified Tasks section alongside
background `goat.tasks`. This is a live UI projection of the chat-backed session and its
`goat.codex_chat_sessions` runtime state, not a copied task row: selecting it still opens
`/chat/<session-id>`, pinning and archiving keep their chat semantics, and the sidebar continues to
show it in conversation history. Local Codex remains a chat-only surface.

## Task Creation

Entry points:

- `apps/goat/lib/tasks.ts`
- `apps/goat/lib/task-runner.ts`
- `apps/goat/lib/integrations/google-data.ts`

`createGoatTaskForUser` creates the task row. It:

- Generates a `goat_task_*` id.
- Normalizes a short display name.
- Computes available harness tools.
- Inserts `goat.tasks` with `status: "queued"`, `stage: "queued"`, `nextRunAt: now`, and an
  initial `harnessSpec`.
- Inserts the durable initial `goat.task_messages` user row in the same transaction.
- Best-effort dispatches the runner through `triggerGoatTaskRun`.

Available task harness tools are user-specific:

- `exa_search` is always available.
- Gmail operation tools are included only when the user has a connected Gmail integration.
- Calendar operation tools are included only when the user has a connected Google Calendar
  integration.
- Linear MCP meta-tools are included only when the user has a connected Linear integration.

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
- `apps/runner/src/goat-harness.ts`

The runner process starts a normal session job worker and a Goat task worker. The HTTP route
`/internal/goat/tasks/:taskId/run` does not claim that exact task directly. It authenticates the
internal token, logs the accepted request, and wakes the in-process Goat worker.

The worker loop:

- Polls roughly every second by default.
- Runs with bounded concurrency, defaulting to `min(2, env.workerConcurrency)`.
- Claims the next eligible task using `FOR UPDATE SKIP LOCKED`.
- Reclaims `running` tasks whose lease has expired.
- Sets `status: "running"`, `stage: "planning"`, increments `attempts`, and writes a lease id,
  lease owner, and lease expiry.
- Heartbeats every 5 seconds while the executor runs.
- Aborts the executor if the lease is lost.

On success it writes:

- `status: "succeeded"`
- `stage: "completed"`
- `result`, copied from the final assistant task message
- final `harnessSpec`
- merged `debugTrace`

On failure it writes:

- `status: "failed"`
- `stage: "failed"`
- `error`
- optional debug trace from the harness error

On user stop it writes:

- `status: "canceled"`
- `stage: "canceled"`
- `error: "Stopped by user."`
- clears the active lease

During the run it also writes lease-owned rows in `goat.task_messages` and `goat.task_events` for
assistant content, tool starts/completions/failures, and task status milestones.

Failed and canceled tasks are not automatically retried by this worker. Only stale `running` tasks are reclaimed.

## Harness Planning

`executeGoatTask` first calls `planGoatHarnessForTask`.

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
- Gmail, Calendar, and Linear operations are selected only if both available to the user and chosen
  by the planner.
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

- `apps/runner/src/goat-harness.ts`
- `apps/runner/src/goat-codex.ts`
- `apps/runner/src/goat-tools.ts`
- `apps/runner/src/goat-google-tools.ts`

After planning, the task reports `stage: "running"` and calls AI SDK `streamText` in the runner
process. The runner:

1. Creates a running assistant `goat.task_messages` row.
2. Builds AI SDK tools from the planned operation names.
3. Streams model text into the assistant row on a short throttle and at step boundaries for
   `assistant_final` runs. For `brain_markdown_report`, the report body is buffered instead.
4. Appends `tool.started`, `tool.completed`, and `tool.failed` events durably.
5. Returns recoverable tool failures to the model as tool results.
6. Completes with the trimmed final assistant message content, or saves the final Markdown report
   into the `research/` Brain folder and completes with an artifact link.

If the final assistant content is empty, the task fails. There is no `goat_result` tool.

Available task harness tools:

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
- The Google tools run server-side in the runner and resolve encrypted OAuth credentials from the
  database.

E2B remains available elsewhere in the runner as a future tool backend; new Goat task runs do not
depend on `/tmp/goat-harness.mjs`, `GOAT_OUTPUT_PATH`, progress stdout parsing, or a sandbox bridge.

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
- `goat.codex_chat_sessions`: persistent cloud sandbox, app-server thread, active turn, status,
  pinned Brain, and host-tool contract version.
- `goat.codex_chat_turns`: leased Cloud Codex turn queue and message linkage.
- `goat.codex_chat_interactions`: pending/resolved/canceled server-initiated requests and responses.
- `goat.codex_chat_events`: normalized Cloud Codex event audit rows.
- `goat.tasks`: durable background task queue, status, stage, result, error, lease, harness spec,
  debug trace, and sandbox id.
- `goat.task_messages`: durable task transcript rows for user, assistant, and tool messages.
- `goat.task_events`: durable task timeline rows for harness planning, message lifecycle, and tool
  lifecycle events.
- `goat.integrations`: connected Gmail, Google Calendar, and Linear accounts.
- `goat.integration_credentials`: encrypted OAuth token payloads.

Task state is deliberately simple:

```text
queued -> running/planning -> running/running
  -> succeeded/completed
  -> failed/failed
```

The UI maps this to Tasks rows and task detail pages. Goat task pages subscribe to TanStack DB
collections backed by Electric shapes for `goat.tasks`, `goat.task_messages`, and
`goat.task_events`, scoped by `user_workos_id`. The active chat also subscribes to scoped
`goat.chat_messages` rows so persisted task completion notifications appear without a manual
refresh.

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
- Change fallback task harness instructions: `apps/runner/src/prompts/goat-task-harness.ts`.
- Add or change harness tools: `apps/runner/src/goat-tools.ts`, implementation files like
  `apps/runner/src/goat-google-tools.ts`, and `GoatTaskToolName` in
  `packages/db/src/goat-schema.ts`.
- Change the task model loop: `executeGoatTask` in `apps/runner/src/goat-harness.ts`.
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
