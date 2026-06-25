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
- `apps/runner` is the long-lived agent-session data plane. It provisions E2B sandboxes, runs the model/tool loop through Vercel AI Gateway and AI SDK Core, writes durable runtime boundaries to Postgres, and streams live-only deltas to active clients.

## Agent Editing Flow

Agent pages read the `agents` table for the current workspace. The editor is a rich text client
component with `@` mention suggestions for supported models, tools, and agent work integrations.

When an agent is created or edited:

1. `createAgent()` or `updateAgent()` in `apps/web/lib/agents/actions.ts` serializes the agent into the `.agent` file format.
2. The app stores the latest title, body, parsed config, content hash, and version in Postgres.
3. The same `db.batch([...])` enqueues a row into the unified `workspace_sync_jobs` outbox (via `enqueueWorkspaceSync`) with the desired hash, repo path, and a `nextRunAt` about 10 seconds out.
4. After the response, the action calls `scheduleWorkspaceSyncDispatch()`, which fire-and-forgets a `workspace.sync_requested` Inngest event.
5. The UI treats the DB write as saved immediately and separately shows GitHub sync status.

The editor debounces saves by about 600ms in `AgentDetail.tsx`. Failed GitHub syncs should not make the editor look unsaved; they set `githubSyncStatus = failed` and keep the error on the agent row.

Agents are one instance of the broader [synced workspace resource](#synced-workspace-resources) pattern.

## Agent File Format

Workspace backing repos store agents as `agents/<slug>/<slug>.agent` files. The format is a Markdown body
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
Postgres and whose file copy is materialized to the managed GitHub repo. Postgres is authoritative.
Every resource type (agents, brain files, agent bundle files) shares **one** outbox table,
`workspace_sync_jobs`, and **one** projector. A write updates the canonical resource row and
enqueues an outbox row in the same `db.batch([...])`; an Inngest event then drains the outbox and
projects all due jobs for the workspace to GitHub as a single commit. Content hashes make repeated
jobs idempotent, and each outbox row stores the desired state plus retry metadata.

Producers (all enqueue via `enqueueWorkspaceSync` from `@opencompany/db/sync-outbox`, which the web
and runner share):

- Agents — `apps/web/lib/agents/actions.ts` and `apps/web/lib/agents/create.ts`. Outbox rows use
  `sourceKind: "agent"` and carry `sourceRef = agentId` (the projector resolves the agent by id, so
  the row survives title-driven renames).
- Brain files — `apps/web/lib/brain/actions.ts`. Outbox rows use `sourceKind: "brain"`.
- Agent bundle files — also enqueued from the agents actions with `sourceKind: "agent_file"`.

The shared pipeline:

- **Outbox** — `workspace_sync_jobs` carries `workspaceId`, `repoPath`, `sourceKind`, `sourceRef`,
  `operation` (`"upsert" | "delete"`), `desiredHash`, `previousPath`/`previousBlobSha` (for
  renames/deletes), `status`, `attempts`, `nextRunAt`, and `lastError`. Coalescing is keyed on the
  unique index `(workspaceId, repoPath)`, so rapid edits to the same path collapse into one pending
  row. The enqueue helper lives in `packages/db/src/sync-outbox.ts`.
- **Projector** — `projectWorkspaceToGitHub()` in `apps/web/lib/workspace-state/project.ts` is the
  only place that writes workspace file state to GitHub. It leases due jobs, resolves canonical
  content, and commits adds/deletes as a single commit through the Git Data API
  (`commitWorkspaceChanges()` in `git-data-api.ts`). It marks source rows synced/failed and updates
  `workspace_repositories.latestHeadSha`/`updatedAt`. It is idempotent under partial failure via
  hash/status guards and caps a batch at 200 jobs per commit.
- **Dispatch** — `scheduleWorkspaceSyncDispatch()` (`sync-dispatch.ts`) fire-and-forgets a
  `workspace.sync_requested` event after the response.

When adding a new synced resource type, give it a `contentHash` column, enqueue through
`enqueueWorkspaceSync` with a new `sourceKind`, and teach the projector's `resolveDesiredContent`
how to serialize it. No new tables or Inngest functions are required.

## GitHub Work Integrations

Agent work integrations are separate from workspace backing storage. GitHub work integration state
is cached as a provider row in `workspace_integrations` plus repository resource rows in
`workspace_integration_resources`.

Agents reference work integration repositories through `.agent` frontmatter under
`integrations.github.repositories`. AMP sessions clone the configured work repository into the
runner sandbox with an installation token minted from the workspace work integration installation,
not the managed workspace-state installation.

AMP itself is modeled as an agent tool, not a workspace integration. Workspace-scoped provider
credentials are not required for AMP; the runner uses the platform `AMP_API_KEY` when the AMP tool
runs. For GitHub-backed AMP runs, the runner also passes a short-lived, repository-scoped GitHub App
installation token into that AMP process so `gh` and HTTPS Git operations use the same work
integration identity as the clone.

## Agent Sessions

Agent sessions turn a saved `.agent` configuration into a live cloud run. The web app stays the
authenticated control plane, while `apps/runner` owns the long-lived data plane.

The important files are:

- `apps/web/lib/agent-sessions/actions.ts`: creates sessions, inserts user messages, appends
  web-authored transcript events, and dispatches Inngest events.
- `apps/web/lib/agent-sessions/runner.ts`: server-to-server calls from web/Inngest to the runner.
- `apps/web/components/SessionView.tsx`: renders persisted messages plus the Durable Stream
  transcript overlay.
- `apps/runner/src/server.ts`: Fastify routes for health and internal mutations.
- `apps/runner/src/agent-loop.ts`: orchestrates a single message run — lease acquisition, assistant streaming, and step bookkeeping. Sandbox provisioning lives in `session-lifecycle.ts`, the model stream loop in `model-stream-runner.ts`, tool dispatch in `tool-dispatcher.ts`, AMP integration in `amp-tool.ts`, and event/usage writes in `lease-writes.ts` and `usage-recorder.ts`.
- `packages/agent-runtime`: shared config resolution, tool catalog, runtime event types, ids,
  and path helpers.

The session flow is:

1. Web action creates `agent_sessions` after WorkOS workspace auth.
2. Web emits `agent.session_started`; Inngest calls the runner start endpoint.
3. Runner creates or reconnects an E2B sandbox and prepares `/home/user/workspace`.
4. Browser opens the same-origin Durable Streams read proxy for the session transcript.
5. Web action inserts a user message, appends that event to the session stream, and emits
   `agent.message_submitted`.
6. Inngest calls the runner message endpoint.
7. Runner resolves the `.agent` config, streams the model through Vercel AI Gateway using AI SDK
   Core, runs allowed tools in E2B, and appends typed runtime events to Postgres. Assistant text
   chunks are accumulated in memory and saved when the assistant message completes. Runner also
   appends durable and transient runtime events to the session Durable Stream.
8. Browser receives lifecycle, tool, command, file, completion, and error events through the
   Durable Stream proxy. On refresh or reconnect, the stream can replay from an offset; high-frequency
   text/reasoning/command deltas are live-streamed and are not replayed from Postgres.

The runner endpoints are documented in [runner.md](./runner.md).

## Inngest Sync

Inngest setup is in:

- `apps/web/lib/inngest/client.ts`
- `apps/web/lib/inngest/functions.ts`
- `apps/web/app/api/inngest/route.ts`
- `scripts/inngest-dev.mjs`

`sync-workspace-to-github` listens for `workspace.sync_requested`, sleeps ~10 seconds to coalesce rapid edits, then calls `projectWorkspaceToGitHub()` in a short drain loop (up to 5 iterations, continuing while the status is `"synced"`) so a backlog larger than one commit's 200-job cap flushes in the same run. `sweep-workspace-sync-outbox` (`apps/web/lib/sync-outbox/sweeper.ts`) runs every minute, scans due `workspace_sync_jobs` rows (pending, retryable failed, or stale-leased `syncing`), groups them by workspace, and re-dispatches `workspace.sync_requested` per workspace, so a missed post-response dispatch recovers without another edit.

`projectWorkspaceToGitHub()`:

- loads due outbox jobs for the workspace and leases them (`status = "syncing"`);
- resolves canonical content per job and plans tree adds/deletes (a rename emits an add at the new path plus a delete of the old);
- skips no-op jobs whose `githubSyncedHash` already matches the current hash;
- commits all changes as one commit via the Git Data API, then marks the source rows synced, advances `workspace_repositories.latestHeadSha`/`updatedAt`, and clears the leased jobs;
- on failure, marks the jobs `failed` with backoff and the source rows `failed`, then rethrows so Inngest retries.

Inngest concurrency is limited to one active projection per workspace. The projector is the only path that materializes workspace files to GitHub.

## Database Model

The high-level table groups are:

- Identity and tenancy: `users`, `workspaces`, `workspace_memberships`, with WorkOS Organizations mapped through `workspaces.workos_organization_id`.
- Agent editing: `agents` stores the latest DB version and parsed config.
- GitHub sync: `workspace_sync_jobs` is the unified outbox of desired materialization state for all synced resources; `workspace_repositories` maps workspaces to managed GitHub backing repos and tracks the latest projected head SHA.
- Agent work integrations: `workspace_integrations` stores connected provider accounts, and
  `workspace_integration_resources` stores provider resources such as GitHub repositories.
- Agent sessions: `agent_sessions`, `agent_session_messages`, and `agent_session_events` store
  durable session ownership, transcript, and boundary/runtime facts.
- Onboarding: `onboarding_responses`.

All app-owned data should stay scoped by `workspaceId` so tenancy remains enforceable.

## Operational Notes

- `bun run dev` starts ngrok when authenticated, then starts the web app, local Inngest dev helper,
  Stripe webhook listener, and runner. ngrok is the expected local path for callback/webhook
  integrations such as GitHub; WorkOS sign-in still redirects to localhost in local development.
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
  `RUNNER_INTERNAL_TOKEN`, `RUNNER_STREAM_TOKEN_SECRET`, `RUNNER_ALLOWED_ORIGINS`,
  `DURABLE_STREAMS_URL`, `DURABLE_STREAMS_TOKEN`, `E2B_API_KEY`,
  `VERCEL_AI_GATEWAY_API_KEY`, optional `OPENCOMPANY_E2B_TEMPLATE`,
  `AMP_API_KEY`, optional `OPENCOMPANY_AMP_E2B_TEMPLATE`, optional
  `OPENCOMPANY_CODEX_E2B_TEMPLATE`, optional `GITHUB_INTEGRATION_APP_ID`
  / `GITHUB_INTEGRATION_APP_PRIVATE_KEY` for AMP work-repository cloning and PRs, and optional
  `RUNNER_E2B_IDLE_TIMEOUT_MS` / `RUNNER_INSTANCE_ID`.
