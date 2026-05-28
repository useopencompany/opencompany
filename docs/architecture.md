# Architecture

This is the short map for coming back to the project after time away. Source files are still the source of truth; this page is meant to orient an agent or teammate quickly.

## Runtime Shape

- `apps/web` is the Next.js app. Server Components read from Postgres through Drizzle, and server actions mutate app state.
- WorkOS AuthKit handles identity. `currentWorkspace()` resolves the signed-in user and workspace before app data is read or written.
- Neon Postgres is the canonical interactive app state. Once a save transaction succeeds, the app
  treats that state as saved. The shared DB client lives in `packages/db/src/client.ts`; the schema
  lives in `packages/db/src/schema.ts`.
- GitHub stores asynchronously materialized workspace files in an OpenCompany-managed private repo
  per workspace. This backing repo is separate from GitHub work integrations that agents use for
  coding workflows.
- Inngest runs background jobs. The app exposes `/api/inngest`, and local development runs the Inngest dev server through the `@opencompany/inngest-dev` workspace.
- `apps/runner` is the long-lived agent-session data plane. It provisions E2B sandboxes, runs the model/tool loop through Vercel AI Gateway and AI SDK Core, and writes replayable runtime events to Postgres.

## Agent Editing Flow

Agent pages read the `agents` table for the current workspace. The editor is a rich text client
component with `@` mention suggestions for supported models, tools, and agent work integrations.

When an agent is created or edited:

1. `createAgent()` or `updateAgent()` in `apps/web/lib/agents/actions.ts` serializes the agent into the `.agent` file format.
2. The app stores the latest title, body, parsed config, content hash, and version in Postgres.
3. The same transaction upserts `agent_sync_jobs` with the desired hash/version and a `nextRunAt` about 10 seconds out.
4. After the response, the action dispatches `agent.sync_requested` to Inngest.
5. The UI treats the DB write as saved immediately and separately shows GitHub sync status.

The editor debounces saves by about 600ms in `AgentDetail.tsx`. Failed GitHub syncs should not make the editor look unsaved; they set `githubSyncStatus = failed` and keep the error on the agent row.

Agents are one instance of the broader [synced workspace resource](#synced-workspace-resources) pattern.

## Agent File Format

Workspace backing repos store agents as `agents/<slug>.agent` files. The format is a Markdown body
with a YAML frontmatter header. In version `2`, saved frontmatter is the runtime contract, while
the web editor derives tool and integration frontmatter deterministically from rich mention nodes.

For the full spec — fields, validation rules, supported models and tools, examples, and the compiled `AgentConfig` shape — see [agent-file.md](./agent-file.md).

The parser and serializer live in `packages/agent-runtime/src/agent-file.ts`; the catalog of
supported models and tools lives in `packages/agent-runtime/src/models.ts` and
`packages/agent-runtime/src/tools.ts`.

## GitHub Workspace State

GitHub logic lives in `apps/web/lib/workspace-state/github.ts`.

- Each workspace gets one managed private repo named from the workspace and id suffix.
- The repo record is cached in `workspace_repositories`.
- GitHub App credentials provide installation tokens; the token is cached in memory until close to expiry.
- Writes use the Contents API. The app reuses the last `githubBlobSha` when available, then refetches on content conflicts.
- `listWorkspaceAgentFiles()` and `readWorkspaceFile()` support manual GitHub-to-DB reconciliation
  through `syncAgentsFromWorkspaceRepository()`.

Current limitation: there is no GitHub webhook ingestion path. External GitHub edits are not part
of the normal authority path; they are only reflected after an explicit sync-from-repository action.

## Synced Workspace Resources

A synced workspace resource is workspace-scoped state whose latest editable version is stored in
Postgres and whose versioned file copy is materialized to the managed GitHub repo. A write updates
Postgres and a sync job together, then an Inngest event materializes the desired GitHub file
asynchronously. Content hashes make repeated jobs idempotent, and the sync job row stores the
desired state plus retry metadata.

Current instances:

- Agents use `agents` and `agent_sync_jobs`. Writes live in `apps/web/lib/agents/actions.ts`,
  materialization lives in `apps/web/lib/agents/materialize.ts`, and dispatch uses
  `agent.sync_requested`.
- Brain files use `brain_files` and `brain_sync_jobs`. Writes live in
  `apps/web/lib/brain/actions.ts`, materialization lives in `apps/web/lib/brain/materialize.ts`,
  and dispatch uses `brain.sync_requested`.

Every implementation of this pattern should include:

- A workspace-scoped unique index on `(workspaceId, path)` when path identifies the resource.
- A resource `contentHash` column.
- A `*_sync_jobs` table with desired hash, `nextRunAt`, status, attempts, last error, and previous
  path/blob metadata for renames or deletes. Include desired version only when the resource is
  versioned.
- A single `db.batch([...])` that writes the resource row and upserts the sync job.
- Fire-and-forget Inngest dispatch after the response has been sent.
- Idempotent materialization that no-ops when the GitHub synced hash already matches current
  content and no rename or delete remains.

Keep the two current implementations separate. When a third synced workspace resource is added,
first decide whether to extract shared helpers under `lib/workspace-state/synced-resource/`, and
whether sync jobs should stay per-resource or move into a generic table. That tradeoff should be
settled before copying the pattern a third time.

Known differences to preserve or reconcile during extraction:

- Agents are versioned and their sync jobs are keyed by `agentId`.
- Brain sync jobs are keyed by `(workspaceId, path)` and carry `operation: "upsert" | "delete"`.
- Brain supports folder rename/delete fan-out, while agents focus on one `.agent` path and
  title-driven renames.

## GitHub Work Integrations

Agent work integrations are separate from workspace backing storage. GitHub work integration state
is cached as a provider row in `workspace_integrations` plus repository resource rows in
`workspace_integration_resources`.

Agents reference work integration repositories through `.agent` frontmatter under
`integrations.github.repositories`. AMP sessions clone the configured work repository into the
runner sandbox with an installation token minted from the workspace work integration installation,
not the managed workspace-state installation.

AMP and Codex are modeled as agent tools, not workspace integrations. Workspace-scoped provider
credentials are not required for these coding agents; the runner uses platform credentials
(`AMP_API_KEY` or `CODEX_API_KEY`) when the tool runs. For GitHub-backed coding-agent runs, the
runner also passes a short-lived, repository-scoped GitHub App installation token into that process
so `gh` and HTTPS Git operations use the same work
integration identity as the clone.

## Agent Sessions

Agent sessions turn a saved `.agent` configuration into a live cloud run. The web app stays the
authenticated control plane, while `apps/runner` owns the long-lived data plane.

The important files are:

- `apps/web/lib/agent-sessions/actions.ts`: creates sessions, inserts user messages, signs stream
  tokens, and dispatches Inngest events.
- `apps/web/lib/agent-sessions/runner.ts`: server-to-server calls from web/Inngest to the runner.
- `apps/web/components/SessionView.tsx`: reads persisted messages and applies SSE events.
- `apps/runner/src/server.ts`: Fastify routes for health, internal mutations, and SSE.
- `apps/runner/src/agent-loop.ts`: orchestrates a single message run — lease acquisition, assistant streaming, and step bookkeeping. Sandbox provisioning lives in `session-lifecycle.ts`, the model stream loop in `model-stream-runner.ts`, tool dispatch in `tool-dispatcher.ts`, coding-agent integrations in `amp-tool.ts` and `codex-tool.ts`, and event/usage writes in `lease-writes.ts` and `usage-recorder.ts`.
- `packages/agent-runtime`: shared config resolution, tool catalog, runtime event types, ids,
  signed stream tokens, and path helpers.

The session flow is:

1. Web action creates `agent_sessions` after WorkOS workspace auth.
2. Web emits `agent.session_started`; Inngest calls the runner start endpoint.
3. Runner creates or reconnects an E2B sandbox and prepares `/home/user/workspace`.
4. Browser opens the runner SSE endpoint with a short-lived signed token.
5. Web action inserts a user message and emits `agent.message_submitted`.
6. Inngest calls the runner message endpoint.
7. Runner resolves the `.agent` config, streams the model through Vercel AI Gateway using AI SDK
   Core, runs allowed tools in E2B, and appends typed runtime events to Postgres. Assistant text
   chunks are accumulated in memory and saved when the assistant message completes.
8. Browser receives lifecycle, tool, command, file, completion, and error events. On refresh, it
   replays from `agent_session_events` instead of relying on an in-memory stream.

The runner endpoints are documented in [runner.md](./runner.md).

## Inngest Sync

Inngest setup is in:

- `apps/web/lib/inngest/client.ts`
- `apps/web/lib/inngest/functions.ts`
- `apps/web/app/api/inngest/route.ts`
- `scripts/inngest-dev.mjs`

`sync-agent-to-github` listens for `agent.sync_requested`, sleeps 10 seconds to coalesce rapid edits, then calls `materializeAgentToGitHub()`. Cron sweepers also scan due `agent_sync_jobs` and `brain_sync_jobs` rows once per minute and re-dispatch the same sync events, so a missed post-response dispatch can recover without another edit.

`materializeAgentToGitHub()`:

- loads the latest agent, workspace, and sync job from Postgres;
- defers if the job's `nextRunAt` is still in the future;
- no-ops and deletes the job if `githubSyncedHash` already matches the current hash;
- marks the agent `syncing`, writes the `.agent` file to GitHub, then marks it `synced`;
- records failure on both the agent and sync job, then rethrows so Inngest retries.

Inngest concurrency is limited to one active sync per `agentId` for agents and one active sync per workspace/path for Brain files. The outbox sweepers fan out recovery events, while the existing sync functions remain the only materialization path.

## Database Model

The high-level table groups are:

- Identity and tenancy: `users`, `workspaces`, `workspace_memberships`, with WorkOS Organizations mapped through `workspaces.workos_organization_id`.
- Agent editing: `agents` stores the latest DB version and parsed config.
- GitHub sync: `agent_sync_jobs` stores desired materialization state; `workspace_repositories` maps workspaces to managed GitHub backing repos.
- Agent work integrations: `workspace_integrations` stores connected provider accounts, and
  `workspace_integration_resources` stores provider resources such as GitHub repositories.
- Agent sessions: `agent_sessions`, `agent_session_messages`, and `agent_session_events` store
  durable session ownership, transcript, and replayable streaming state.
- Onboarding: `onboarding_responses`.

All app-owned data should stay scoped by `workspaceId` so tenancy remains enforceable.

## Operational Notes

- `bun run dev` starts ngrok when authenticated, then starts the web app, local Inngest dev helper,
  Stripe webhook listener, and runner. ngrok is the expected local path for callback/webhook
  integrations such as GitHub.
- `bun run dev:web` runs only the web app.
- `bun run dev:runner` runs only the runner.
- `bun run db:generate` creates migrations from `packages/db/src/schema.ts`.
- `bun run db:migrate` applies migrations to `DATABASE_URL`.
- Production releases run migrations from the `Release Production` GitHub Actions workflow before
  deploying Vercel web and Render runner.
- GitHub workspace-state env vars are `OPENCOMPANY_GITHUB_ORG`, `GITHUB_APP_ID`,
  `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`. GitHub work integrations use the
  separate `GITHUB_INTEGRATION_APP_*` env vars.
- Inngest uses `INNGEST_DEV` for local development; hosted environments should also set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.
- Runner env vars are `RUNNER_PUBLIC_URL`, optional `RUNNER_INTERNAL_URL`,
  `RUNNER_INTERNAL_TOKEN`, `RUNNER_STREAM_TOKEN_SECRET`, `RUNNER_ALLOWED_ORIGINS`, `E2B_API_KEY`,
  `VERCEL_AI_GATEWAY_API_KEY`, optional `OPENCOMPANY_E2B_TEMPLATE`,
  `AMP_API_KEY`, `CODEX_API_KEY`, optional `OPENCOMPANY_AMP_E2B_TEMPLATE`, optional
  `OPENCOMPANY_CODEX_MODEL`, optional `OPENCOMPANY_CODEX_E2B_TEMPLATE`, optional `GITHUB_INTEGRATION_APP_ID`
  / `GITHUB_INTEGRATION_APP_PRIVATE_KEY` for coding-agent work-repository cloning and PRs, and optional
  `RUNNER_E2B_IDLE_TIMEOUT_MS` / `RUNNER_INSTANCE_ID`.
