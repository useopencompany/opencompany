# Agent runner

The runner is the long-lived data plane for agent sessions. The web app remains the
authenticated control plane: it creates session/message rows, emits Inngest events, and renders
the session UI. The runner receives internal start/message/abort calls, owns the model loop, uses
E2B for sandbox execution, writes durable turn boundaries to Postgres, and publishes live-only
deltas to active SSE clients.

This page is the quickest orientation point for resuming runner work.

## Why this exists

The product needs agent sessions that can run longer than a serverless request, stream with low
latency, execute tools against a real filesystem, and survive page refreshes. The runner is a
small dedicated service for that live loop. Next.js stays responsible for auth, workspace access,
and user-facing mutations. Inngest coordinates lifecycle events and retries, but it does not host
the token stream.

The V1 loop is intentionally custom and narrow:

- Resolve the stored `.agent` config into a system prompt, model id, and allowed tools.
- Start or reconnect an E2B sandbox for the session.
- Stream model output through Vercel AI Gateway with AI SDK Core.
- Execute only the approved local tools inside the session workdir.
- Persist durable state changes to Postgres while keeping high-frequency stream deltas live-only.

## Package map

- `apps/runner` is the Fastify/Bun service. It owns HTTP routes, sandbox provisioning, model
  streaming, tool execution, and event writes.
- `packages/agent-runtime` is the shared contract package. It owns config resolution, runtime
  event types, ids, signed stream tokens, path confinement helpers, and the core tool catalog.
- `packages/db` owns the Drizzle schema, generated migrations, and the two DB clients:
  the default `neon-http` client (`@opencompany/db/client`, used by web) and the pooled
  `node-postgres` client (`@opencompany/db/pool`, used by the runner). The runner wires
  the pooled client through its own `apps/runner/src/db.ts` so the pooled driver can
  never leak into web code.
- `apps/web/lib/agent-sessions` owns web-facing session creation, message submission, signed SSE
  token creation, and server-to-server runner calls.
- `apps/web/components/SessionView.tsx` renders persisted messages and applies streamed runtime
  events from the runner.
- `apps/web/lib/inngest/functions.ts` contains the lightweight lifecycle functions that call the
  runner after web actions emit events.

## Request flow

1. A user starts an agent session from the web app after normal WorkOS workspace auth.
2. The web app creates `agent_sessions` and emits `agent.session_started`.
3. Inngest calls `POST /internal/sessions/:id/start` on the runner with
   `RUNNER_INTERNAL_TOKEN`.
4. The runner marks the session `provisioning`, creates or reconnects the E2B sandbox, prepares
   the capability-scoped workspace layout, clones the selected connected GitHub repo into `work/`
   for AMP agents, and marks the session `ready`.
5. The browser opens `GET /sessions/:id/events?token=...&after=...` directly against the runner.
   The token is a short-lived HMAC token minted by the web app.
6. When the user sends a message, the web app inserts `agent_session_messages(role = user)` and
   directly nudges `POST /internal/sessions/:id/messages/:messageId/run` when runner env is
   configured. If that direct nudge is unavailable or fails, it falls back to emitting
   `agent.message_submitted` for the Inngest path.
7. Inngest calls the same runner message endpoint on fallback/retry paths.
8. The runner claims a local abort controller, creates a running assistant message, resolves the
   `.agent` config, calls Vercel AI Gateway through AI SDK `streamText`, lazily connects/prepares
   E2B only if a tool executes, writes runtime events to Postgres, and completes or fails the
   session. Assistant text chunks are accumulated in memory and persisted on message completion.

## Model and tool loop

The current runner loop lives in `apps/runner/src/agent-loop.ts`.

Important details:

- Model calls use `createGateway({ apiKey: VERCEL_AI_GATEWAY_API_KEY })` and
  `streamText({ model: gateway(runtime.model.name), ... })`.
- `runtime.model.name` comes from the parsed `.agent` config, so model routing remains data-driven.
- AI SDK Core owns the multi-step tool loop via `stopWhen: stepCountIs(8)`.
- Runtime tools are created from `CORE_TOOL_DEFINITIONS` and then filtered by the agent's allowed
  tool names.
- Complete validated tool input emits `tool.started`; streamed partial tool input is not persisted.
- Tool execution calls `runSandboxTool()` and publishes transient `command.output`, emits `file.changed`,
  `tool.completed`, and recoverable `tool.failed` results.
- `edit_file` applies ordered exact-string replacements atomically to existing files. It is the
  preferred tool for targeted file changes; `write_file` remains for creates and intentional
  full-file overwrites.
- Hosted tools have per-assistant-message budgets in the runner. Over-budget calls return a
  recoverable `tool.failed` result before reaching the provider, which bounds runaway search/fetch
  fan-out even if prompting fails.
- Message runs do not hydrate E2B before the model call. The sandbox is connected/prepared on the
  first tool execution, so text-only fast-model turns avoid that fixed pre-token latency.
- Run control (abort/lease/archive) is split into a free local check and a throttled remote read,
  so a streaming turn no longer does a DB read per token. The `checkAbort` gate
  (`createRunControlGate` in `run-control.ts`) checks the local `AbortController` synchronously on
  every stream part and tool-output delta — that path stays instant for the stop button and locally
  detected lease loss. The DB-backed reconciliation (abort requested elsewhere, lease reclaimed,
  session archived) is folded with the lease heartbeat into a single `UPDATE … RETURNING`
  round-trip and throttled to `RUN_HEARTBEAT_INTERVAL_MS` (5s). Step/tool/completion boundaries
  (`finish-step`, before+after each tool execution via `withRunControlChecks`, before persisting
  completion) pass `{ force: true }` to reconcile immediately regardless of the throttle. A turn
  therefore performs O(turn-duration / interval) run-control reads instead of O(tokens), and each
  read also refreshes the lease, so long tool calls keep the lease alive.
- Persisted tool messages are kept for UI/debug history, but only user and assistant messages are
  replayed into later model requests. This avoids replaying orphan tool results without their
  matching assistant tool calls.
- The runner does not clone the full workspace repo into E2B. It materializes only configured
  Brain files under `/home/user/workspace/brain` plus a session-local
  `/home/user/workspace/work` directory. `work/` is initialized as an empty scratch git repository
  so `git_diff` can report session-local scratch changes without exposing the managed workspace
  repo. Connected GitHub repositories are cloned lazily into `work/<repo>` only when code or files
  are needed; `gh` can still run metadata commands before a clone.
- For shell, `gh`, and AMP commands that need connected GitHub repositories, the runner mints a
  repository-scoped GitHub App installation token and passes it only to that command through
  `GH_TOKEN`, a temporary `GH_CONFIG_DIR`, and process-scoped Git HTTP extraheader config. When
  exactly one repository is attached, the command env also includes `GH_REPO`; multi-repo sessions
  must pass `--repo owner/repo` to `gh` commands. This avoids persisting credentials in the sandbox
  home directory or repository remote.
- AMP owns its coding checkout and may clone the selected connected repository directly into
  `work/` for that tool run.
- Shell commands run from `/home/user/workspace`, where `work/` and `brain/` are visible.
- OpenCompany-owned metadata lives outside the tool roots under `/home/user/.opencompany`, including
  the full serialized `.agent` source and Brain manifest.

V1 tools:

- `shell`
- `read_file`
- `read_skill`
- `edit_file`
- `write_file`
- `list_files`
- `git_diff`
- `delegate_to_agent` when the saved agent references other workspace agents; pass `agent` to
  start an inspectable child session hidden from sidebar history, or pass a returned
  `childSessionId` as `sessionId` to continue that child session
- `update_agent_file` when the saved agent enables the `agent-self-edit` skill; validates and
  persists version-guarded changes to the agent's own `.agent` configuration and queues GitHub sync
- `amp_coder` when the saved agent enables the AMP coding-agent tool with a valid repository binding
- `linear__*` dynamic tools when the saved agent enables `@linear`, the workspace has the `mcp`
  experiment on, and Linear MCP has workspace OAuth or bearer-token credentials configured
- `slack__*` dynamic tools when the saved agent enables `@slack`, the workspace has the `mcp`
  experiment on, and Slack MCP has workspace OAuth credentials configured

`amp_coder` returns an `ampThreadId`. Later follow-up tasks can pass that id back as
`ampThreadId` so the runner invokes `amp threads continue` instead of starting a fresh Amp thread.

File-oriented tools must remain confined to `/home/user/workspace/work` or configured
`/home/user/workspace/brain` paths, and their paths must be prefixed with `work/` or `brain/`.
Enabled skills are also materialized as read-only files under `/home/user/workspace/skills/<id>/`;
use `read_skill` with the skill id and an optional path inside that skill directory rather than
generic file tools.
Keep path validation in the runtime/sandbox layer rather than relying on model behavior.
For connected GitHub code edits, clone the target repository into `work/<repo>` first unless the
workflow is delegated to `amp_coder`.

## Event model

`agent_session_events` stores durable session boundaries and audit-worthy runtime facts. Events are
append-only and have monotonic numeric ids. High-frequency assistant text, reasoning, and command
output deltas are transient SSE messages with `id: null`; they are not inserted into Postgres and
are not replayed after reconnect. On reconnect/open, the browser refetches session detail from the
web app to catch durable state it missed while disconnected.

The SSE endpoint intentionally sends default `message` events with a JSON body that includes the
runtime `type`. Do not send custom SSE event names unless the client is updated too; the current UI
uses `EventSource.onmessage`.

Common event types:

- `session.status`
- `message.created`
- `message.completed`
- `tool.started`
- `file.changed`
- `tool.completed`
- `tool.failed`
- `session.error`
- `session.incomplete` — the turn still `completed`, but the model appears to have
  stopped mid-task (announced a next action it never took). Distinct so unattended
  runs don't look cleanly green; paired with an `opencompany.runner_turn_incomplete`
  warning log. `payload.reason` is a stable code; currently
  `announced_unexecuted_next_action`.

Common transient-only event types:

- `message.delta`
- `message.reasoning_delta`
- `command.output`

## Database tables

Runner state is stored in these tables:

- `agent_sessions`: ownership, status, model, sandbox id, workdir, lease id, abort flag, and last
  error.
- `agent_session_messages`: durable user, assistant, and tool messages.
- `agent_session_events`: append-only durable event log for status, message/tool boundaries, usage,
  errors, file changes, and archive/after-session lifecycle.

The schema is in `packages/db/src/schema.ts`. Use `bun run db:generate` for schema changes and
`bun run db:migrate` to apply them to `DATABASE_URL`.

## Database driver

Unlike the web app, which uses the per-request `neon-http` driver, the runner is a
long-lived process and uses a pooled `node-postgres` driver (`@opencompany/db/pool`,
wired through `apps/runner/src/db.ts`). This gives it persistent connections, real
`db.transaction(...)`, and multi-statement SQL — which the atomic session-execution
lease writes rely on (`lease-writes.ts`). See
[database.md](./database.md#two-drivers-neon-http-web-vs-pooled-node-postgres-runner)
for the full rationale and pool-sizing math.

The runner must connect to Neon's **direct** (non-pooled) endpoint, not the `-pooler`
host: PgBouncer transaction pooling cannot do interactive transactions or
`LISTEN`/`NOTIFY`. Set `RUNNER_DATABASE_URL` to the direct URL, or leave it unset and
the runner derives the direct host from `DATABASE_URL` by stripping `-pooler`. Pool size
is `RUNNER_DB_POOL_MAX` (default 10). The pool is drained on `SIGTERM`/`SIGINT` after
in-flight jobs and HTTP requests finish, before the process exits.

## Local development

Required environment variables:

- `DATABASE_URL`
- `RUNNER_DATABASE_URL` (optional; direct/non-pooled Neon URL for the runner pool.
  Defaults to `DATABASE_URL` with the `-pooler` host label stripped.)
- `RUNNER_DB_POOL_MAX` (optional; runner DB pool size, defaults to `10`)
- `RUNNER_PUBLIC_URL` (`http://localhost:3040` locally)
- `RUNNER_INTERNAL_URL` (`http://localhost:3040` locally; optional when it matches `RUNNER_PUBLIC_URL`)
- `RUNNER_INTERNAL_TOKEN`
- `RUNNER_STREAM_TOKEN_SECRET`
- `RUNNER_ALLOWED_ORIGINS` (`http://localhost:3000` locally)
- `E2B_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY`
- `EXA_API_KEY` (optional; required only for agents that enable the Exa hosted tool)
- `X_API_BEARER_TOKEN` (optional; required only for agents that enable the X hosted tool)
- `AMP_API_KEY` (required only for agents that enable the AMP coding tool)
- `OPENCOMPANY_AMP_E2B_TEMPLATE` (optional; AMP sessions default to E2B's `amp` template)
- `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` (required when agents use workspace MCP credentials)
- `RUNNER_E2B_IDLE_TIMEOUT_MS` (optional, defaults to `30000`)
- `RUNNER_INSTANCE_ID` (optional stable identity for hosted multi-instance deployments)
- optional GitHub App env vars used for Brain sync back to the managed workspace repo:
  `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`
- optional GitHub integration app env vars for cloning configured work repositories into E2B and
  creating AMP pull requests: `GITHUB_INTEGRATION_APP_ID` and
  `GITHUB_INTEGRATION_APP_PRIVATE_KEY`
- optional Better Stack error capture env var: `BETTER_STACK_ERRORS_DSN`

Production runner logs are structured JSON on stdout and should be forwarded by Render to the
Better Stack source `opencompany-runner-production`. Do not add browser/client log capture to debug
runner issues; search server logs by `session_id` first.

New E2B sandboxes are created with lifecycle auto-pause and auto-resume enabled. The runner keeps
the sandbox on a one-hour timeout while it is actively preparing or executing work, then resets it to
`RUNNER_E2B_IDLE_TIMEOUT_MS` so unused sandboxes pause shortly after the runner stops touching them.
If the stored E2B sandbox id has already disappeared, the runner creates a fresh sandbox instead of
retrying the stale id.

`apps/runner/src/load-env.ts` loads the repo root `.env.local` for local runs. `bun run env:pull`
also merges the runner env vars from Infisical `dev` + `/runner` into `.env.local`, including
hosted-tool secrets like `EXA_API_KEY` and `X_API_BEARER_TOKEN` when they are present.

Run the app, Inngest dev server, and runner together:

```sh
bun run dev
```

Or run the runner separately:

```sh
bun run dev:runner
```

The runner exposes:

- `GET /healthz`
- `POST /internal/sessions/:id/start`
- `POST /internal/sessions/:id/messages/:messageId/run`
- `POST /internal/sessions/:id/abort`
- `GET /sessions/:id/events`

Internal mutation endpoints require `Authorization: Bearer $RUNNER_INTERNAL_TOKEN`. Browser SSE
uses a short-lived signed token minted by the web app with `RUNNER_STREAM_TOKEN_SECRET`; the same
secret must be set on the runner.

Useful checks:

```sh
curl http://localhost:3040/healthz
bun --filter @opencompany/runner typecheck
bun run typecheck
bun run lint
bun run test
```

When testing a live session locally, keep these pieces running:

- Next.js web app on `localhost:3000`
- Inngest dev server
- runner on `localhost:3040`

If web logs show `ECONNREFUSED` from `callRunner()`, the runner is not listening at
`RUNNER_INTERNAL_URL` or `RUNNER_INTERNAL_URL` points at the wrong port. Local development falls back
to `RUNNER_PUBLIC_URL` when `RUNNER_INTERNAL_URL` is unset.

If the model response never appears after completion, first check that SSE frames are arriving as
default `message` events and that the web UI is applying `message.completed` events. Browser console
or network errors on `/sessions/:id/events` usually mean `RUNNER_PUBLIC_URL`,
`RUNNER_ALLOWED_ORIGINS`, or `RUNNER_STREAM_TOKEN_SECRET` does not match between the web app and
runner.

If Vercel AI Gateway errors mention missing tool calls for function outputs, check the prompt
history passed to the model. Tool-result messages need matching assistant tool-call messages in the
same model transcript. The current code avoids this by not replaying persisted tool messages into
future requests.

## Hosting

V1 is designed for Render Standard near the Neon database region. `render.yaml` defines the web
service and required secrets. Keep the Next.js app on Vercel, point `RUNNER_PUBLIC_URL` at the
browser-reachable Render service URL, and set `RUNNER_ALLOWED_ORIGINS` to the exact Vercel web
origin. Render does not automatically inherit Vercel environment variables; keep `render.yaml` in
sync with the runner env contract and set the secret values in Render for hosted deployments.

Render auto-deploys are disabled in `render.yaml` so the GitHub Actions production release workflow
can run database migrations, deploy web, trigger Render, and smoke check the full release in order.
See [deployment.md](./deployment.md) for the release flow.

The mature migration path is the same runner container on ECS/Fargate behind an ALB when queue
depth, connection volume, or private networking needs justify the operational overhead.

Avoid placing the live model/E2B stream inside a serverless function. The runner is deliberately a
long-lived service so it can hold SSE, model streams, sandbox command streams, and abort state
without fighting request-duration limits.

## Current limitations

- Lease enforcement is in Postgres: a job-delivery lease (`jobs.ts`) guarantees one runner
  instance dispatches a given job, and a session-execution lease (`run-control.ts`) gates
  every persisted write through `lease-writes.ts` so a stale runner cannot stomp on a
  session reclaimed elsewhere. Each guarded write is a single atomic statement that inserts
  or updates only `WHERE EXISTS (lease still current)` (assistant/tool messages, model and
  tool usage, and the durable event append in `events.ts`), so there is no check-then-write
  window for a concurrent reclaim to slip through and each write costs one round-trip instead
  of two. "Zero rows written" means the lease was lost (`requireLeaseWrite` throws
  `StaleRunLeaseError`), distinguished from the idempotent "assistant already exists" skip.
  Local `activeRuns` is only a fast in-process guard on top of that.
- Abort is process-local for active streams and persisted as a session flag, but deeper cooperative
  cancellation inside long sandbox commands is still minimal.
- The UI is still a custom DB-event/SSE client, not AI SDK UI `useChat`. Live deltas are ephemeral;
  final transcript state is recovered from persisted messages and durable boundary events.
- E2B workspace hydration is capability-scoped. Full workspace repo cloning is intentionally not
  part of V1; add explicit file mounts later if agents need broader project access.
