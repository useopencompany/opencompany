# Goat LLM System

This is the current-state map of how Goat answers chat messages and runs durable LLM tasks. It is
intended as a baseline before changing the system.

## Current Shape

Goat has two LLM paths:

1. **Foreground chat:** a short-lived AI SDK stream from the browser to `apps/goat/app/api/chat`.
   This agent either answers directly or calls `start_goat_task`.
2. **Background task:** a durable row in `goat.tasks` claimed by `apps/runner`, planned into a
   just-in-time harness, then executed inside an E2B sandbox.

The Goat task path is not currently a full OpenCompany `.agent` session. It reuses runner
infrastructure, Vercel AI Gateway, E2B, leases, observability, and the Google tool bridge, but it
does not yet use `agent_sessions`, `.agent` files, Brain mounts, skills, approvals, MCP, or
`delegate_to_agent`.

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
        OR call start_goat_task
          insert goat.tasks row
          POST /internal/goat/tasks/:taskId/run

Runner
  Goat task worker wakes/polls
    claim queued task with lease
    plan harness spec with Gateway planner model
    create/connect E2B sandbox
    write /tmp/goat-harness.mjs
    run node harness with Gateway, Exa, and optional bridge env
      model calls tools until goat_result or fallback text
    parse final JSON line
    mark task succeeded or failed

Goat UI
  refreshes task list while queued/running tasks exist
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
id and calls `router.refresh()` so the server-rendered task list and persisted chat catch up.

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
6. Creates the `start_goat_task` tool context.
7. Calls `streamText` through Vercel AI Gateway with the selected model.
8. Streams the UI message response back to the browser.
9. Persists the assistant message, debug trace, and optional task link on finish.

The chat agent's system prompt is `GOAT_DEFAULT_AGENT_SYSTEM`. Its only tool is
`start_goat_task`. The prompt tells the model to answer directly for small or ambiguous work and
start a task for research, monitoring, comparison, or durable work that belongs in Results.

The default chat model is `moonshotai/kimi-k2.6`. The user-selected chat model is also copied into
new tasks as their execution model.

Important runtime settings:

- `temperature: 0.2`
- `maxOutputTokens: 900`
- `stopWhen: stepCountIs(3)`
- `abortSignal: request.signal`

The chat path is a normal request/response stream. It has no runner lease or durable retry. The
durable boundary starts only when `start_goat_task` creates a task row.

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
- Best-effort dispatches the runner through `triggerGoatTaskRun`.

Available harness tools are user-specific:

- `exa` is always available if the runner has `EXA_API_KEY`.
- `goat_result` is always included as the final-output tool.
- `gmail` is included only when the user has a connected Gmail integration.
- `google_calendar` is included only when the user has a connected Google Calendar integration.

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
- `result`
- final `harnessSpec`
- merged `debugTrace`
- `sandboxId`

On failure it writes:

- `status: "failed"`
- `stage: "failed"`
- `error`
- optional debug trace from the harness error

Failed tasks are not automatically retried by this worker. Only stale `running` tasks are reclaimed.

## Harness Planning

`executeGoatTask` first calls `planGoatHarnessForTask`.

The planner is a separate Gateway call using:

- URL: `https://ai-gateway.vercel.sh/v1/chat/completions`
- Model: `anthropic/claude-sonnet-4.6`
- `temperature: 0`
- strict JSON schema response format

The planner returns a `GoatHarnessSpec`:

```ts
type GoatHarnessSpec = {
  prompt?: string;
  model?: string;
  tools?: ("exa" | "gmail" | "google_calendar" | "goat_result")[];
  resultMode?: "freeform";
};
```

Normalization is intentionally conservative:

- `exa` and `goat_result` are always selected.
- Gmail and Calendar are selected only if both available to the user and chosen by the planner.
- The execution model is forced back to the task's selected model.
- `resultMode` is currently always `freeform`.

The planner request and response content are stored in `debugTrace.planner`.

## Sandbox Lifecycle

Entry points:

- `apps/runner/src/goat-harness.ts`
- `apps/runner/src/sandbox.ts`

After planning, the task reports `stage: "sandboxing"` and calls `createOrConnectSandbox`.

For Goat tasks:

- The saved `task.sandboxId` is used if present.
- If connect fails because the sandbox is gone, a new E2B sandbox is created.
- The template is `env.e2bTemplate`.
- No platform env vars are attached at sandbox creation time.
- The sandbox timeout is armed to pause when idle.

After the sandbox is ready, the task reports `stage: "running"` with the current `sandboxId`.

The runner writes a generated script to:

```text
/tmp/goat-harness.mjs
```

Then it runs:

```text
node /tmp/goat-harness.mjs
```

with a 10 minute timeout and these env vars:

- `VERCEL_AI_GATEWAY_API_KEY`
- `EXA_API_KEY`
- `GOAT_MODEL`
- `GOAT_PROMPT`
- `GOAT_HARNESS_SPEC`
- optional `GOAT_TOOL_BASE_URL`
- optional `GOAT_TOOL_TOKEN`

This sandbox is not prepared like a full agent session. It does not materialize `agent/`, `brain/`,
`skills/`, attachments, or a work repository. It is a compact throwaway harness runtime.

## Harness Execution

The generated script is built by `buildGoatHarnessScript` in `apps/runner/src/goat-harness.ts`.

Inside the sandbox, it:

1. Reads required env vars.
2. Builds OpenAI-compatible function tool definitions from `GOAT_HARNESS_SPEC`.
3. Sends chat completions to Vercel AI Gateway.
4. Allows up to `MAX_TOOL_STEPS = 8`.
5. Executes tool calls.
6. Finishes when the model calls `goat_result({ text })`.
7. Falls back to final assistant text if the model produced useful text but did not call
   `goat_result`.
8. Prints one final JSON object to stdout.

Available harness tools:

- `exa_search`: runs directly inside the sandbox against Exa.
- `gmail_search`
- `gmail_get_message`
- `gmail_list_threads`
- `gmail_get_thread`
- `calendar_list_calendars`
- `calendar_list_events`
- `calendar_get_event`
- `calendar_get_freebusy`
- `goat_result`

The Google tools are available only when the runner provided bridge env vars. The harness itself is
read-only by instruction and by the exposed tool set.

The final stdout object is one of:

```json
{ "ok": true, "result": "..." }
```

or:

```json
{ "ok": false, "error": "..." }
```

Both shapes may include `debugTrace`. The runner scans stdout from the bottom and parses the last
valid JSON-looking line.

## Google Tool Bridge

Entry points:

- `apps/runner/src/goat-tool-auth.ts`
- `apps/runner/src/server.ts`
- `apps/runner/src/goat-google-tools.ts`
- `packages/db/src/goat-integrations.ts`

Google credentials are not sent to the sandbox.

When the planned harness needs Gmail or Calendar, the runner passes:

- `GOAT_TOOL_BASE_URL`: `/goat/tools/:taskId` on the public runner URL.
- `GOAT_TOOL_TOKEN`: HMAC-signed payload with `taskId`, `userWorkosId`, and expiry.

Local dev needs that public runner URL because E2B sandboxes cannot reach `localhost:3040`.
`bun run dev:goat` starts a local Goat dev proxy and, when ngrok is available, injects
`RUNNER_LLM_BROKER_PUBLIC_URL` so `/goat/tools/*` reaches the local runner.

The sandbox calls the bridge with:

```json
{ "name": "gmail_search", "args": { "...": "..." } }
```

The runner:

1. Verifies the bearer token and task id.
2. Checks the tool name is known.
3. Resolves the user's connected account.
4. Loads encrypted OAuth credentials from the database.
5. Refreshes the access token when needed.
6. Calls the Google API server-side.
7. Returns sanitized JSON output to the sandbox.

If Google rejects a refresh token, the integration is marked `needs_reauth`.

## Data Model

Goat-specific tables live in `packages/db/src/goat-schema.ts`.

Important tables:

- `goat.users`: WorkOS-backed Goat user profile.
- `goat.chat_sessions`: one open or closed chat thread per user.
- `goat.chat_messages`: persisted user and assistant chat messages. Assistant messages can point
  at a `taskId` so the UI can render a task card.
- `goat.tasks`: durable background task queue, status, stage, result, error, lease, harness spec,
  debug trace, and sandbox id.
- `goat.integrations`: connected Gmail and Google Calendar accounts.
- `goat.integration_credentials`: encrypted OAuth token payloads.

Task state is deliberately simple:

```text
queued -> running/planning -> running/sandboxing -> running/running
  -> succeeded/completed
  -> failed/failed
```

The UI maps this to Results rows and task detail pages. `TaskAutoRefresh` refreshes while any task
is queued or running.

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
- Runner-hosted tool bridge: executes private Google API calls outside the sandbox.

For the broader platform, multi-agent means actual nested agent sessions:

- `.agent` files can reference other agents.
- The parent model gets `delegate_to_agent`.
- Delegation creates child sessions with their own leases, model turns, tools, sandbox state, and
  transcript.
- Parent sessions can await child completion and receive child results.

Goat does not currently expose that parent/child session model in its app surface.

## Tweak Points

Common changes and where they belong:

- Change when chat starts a task: `GOAT_DEFAULT_AGENT_SYSTEM` and `createGoatChatToolContext` in
  `apps/goat/lib/chat-agent.ts`.
- Change chat streaming behavior: `apps/goat/app/api/chat/route.ts` and
  `apps/goat/components/GoatSurface.tsx`.
- Change task creation defaults: `createGoatTaskForUser` in `apps/goat/lib/tasks.ts`.
- Change runner dispatch: `apps/goat/lib/task-runner.ts` and the Goat route in
  `apps/runner/src/server.ts`.
- Change planner behavior or harness spec schema: `planGoatHarnessForTask` in
  `apps/runner/src/goat-harness.ts`.
- Add or change harness tools: `buildGoatHarnessScript` in `apps/runner/src/goat-harness.ts`, plus
  `GoatHarnessToolId` in `packages/db/src/goat-schema.ts`.
- Add server-side private tools: the bridge route in `apps/runner/src/server.ts`, auth in
  `apps/runner/src/goat-tool-auth.ts`, and implementation files like
  `apps/runner/src/goat-google-tools.ts`.
- Change sandbox template or lifecycle: `apps/runner/src/sandbox.ts`, `apps/runner/src/env.ts`,
  and the `executeGoatTask` call site.
- Move Goat onto full multi-agent sessions: start from `apps/runner/src/agent-loop.ts`,
  `apps/runner/src/session-lifecycle.ts`, `apps/runner/src/delegation.ts`, and
  `docs/agent-file.md`.

## Current Constraints And Risks

- Direct chat is not durable beyond persisted messages. It does not use runner leases.
- Goat tasks are text-result only. They do not persist files or artifacts from the sandbox.
- The harness script is generated as a string in TypeScript, so tool schema changes require careful
  tests.
- Gateway and Exa keys are injected into the task sandbox. Google credentials stay server-side
  behind the bridge.
- Debug traces can contain prompts, tool arguments, snippets, and truncated private Google results.
  Treat them as sensitive application data.
- The harness is instructed to use `goat_result`, but the runner accepts fallback assistant text
  when present.
- The task worker reclaims expired running work, but failed tasks are terminal unless a future
  feature explicitly requeues them.
- Goat's current harness has no built-in child-agent delegation. Adding true multi-agent behavior
  means either adopting the full agent session runner or designing a task-local child-agent model.
