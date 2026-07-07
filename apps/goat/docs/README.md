# Goat LLM System

This is the current-state map of how Goat answers chat messages and runs durable LLM tasks. It is
intended as a baseline before changing the system.

## Current Shape

Goat has two LLM paths:

1. **Foreground chat:** a short-lived AI SDK stream from the browser to `apps/goat/app/api/chat`.
   This agent answers directly, calls `goat_brain`, or calls `start_task`.
2. **Background task:** a durable row in `goat.tasks` claimed by `apps/runner`, planned into a
   `goat.harness.v1` config, then executed by an AI SDK model loop in the runner process.

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
        OR call start_task
          insert goat.tasks row
          POST /internal/goat/tasks/:taskId/run

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
  subscribes to Electric task, task message, and task event shapes
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
- `model`: the current chat model.
- `message`: only the newest UI message.

When a stream finishes, the route attaches `sessionId` in message metadata. The client stores that
id and calls `router.refresh()` only so persisted chat server props catch up. Persisted Goat app
state such as tasks, task run events, integrations, and Brain documents is read through
TanStack DB collections backed by Electric shapes.

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

The chat agent's system prompt is `OPENCOMPANY_CHAT_SYSTEM_PROMPT`, assembled from structured
blocks in `apps/goat/lib/prompts/main-chat.ts`. Its tools are `start_task`, `goat_brain`, and
optional `web_search`; tool descriptions live in `apps/goat/lib/prompts/tool-descriptions.ts`. The
prompt tells the model to answer directly for small or ambiguous work, use `goat_brain` for durable
personal context, use `web_search` for one-shot public freshness checks when Exa is configured, and
start a task for research, monitoring, comparison, connected-account work, or durable work that
belongs in Results.

The default chat model is `anthropic/claude-sonnet-5`. New tasks store the chat-selected model at
creation time, then the runner planner chooses the task execution model from its allowed model
catalog and writes that planned model back to the task row.

Important runtime settings:

- `maxOutputTokens: 900`
- `stopWhen: stepCountIs(8)`
- `abortSignal: request.signal`

The chat path is a normal request/response stream. It has no runner lease or durable retry. The
durable boundary starts only when `start_task` creates a task row.

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
- Execution model options: `moonshotai/kimi-k2.6` by default, `anthropic/claude-sonnet-5` for more
  complex execution or writing, and `openai/gpt-5.5` for coding, Codex, or sharper analysis.

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

- `apps/runner/src/goat-google-tools.ts`
- `packages/db/src/goat-integrations.ts`

The runner:

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

- `goat.users`: WorkOS-backed Goat user profile.
- `goat.chat_sessions`: one open or closed chat thread per user.
- `goat.chat_messages`: persisted user and assistant chat messages. Assistant messages can point
  at a `taskId` so the UI can render a task card. Task completion notifications are also persisted
  here as synthetic assistant messages.
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

The UI maps this to Results rows and task detail pages. Goat task pages subscribe to TanStack DB
collections backed by Electric shapes for `goat.tasks`, `goat.task_messages`, and
`goat.task_events`, scoped by `user_workos_id`. The active chat also subscribes to scoped
`goat.chat_messages` rows so persisted task completion notifications appear without a manual
refresh.

Settings and Brain use the same pattern for `goat.integrations`, `goat.brain_folders`, and
`goat.brain_documents`. Server props are initial render fallbacks; after hydration, live Electric
rows are the source of truth for persisted Goat state.

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

- Change when chat starts a task: `OPENCOMPANY_CHAT_SYSTEM_PROMPT` and
  `createOpenCompanyChatToolContext` in `apps/goat/lib/chat-agent.ts`; prompt blocks live in
  `apps/goat/lib/prompts/main-chat.ts`.
- Change lightweight chat web search: `web_search` in `apps/goat/lib/chat-agent.ts` and the Exa
  callback in `apps/goat/app/api/chat/route.ts`.
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
