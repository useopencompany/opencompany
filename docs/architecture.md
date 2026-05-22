# Architecture

This is the short map for coming back to the project after time away. Source files are still the source of truth; this page is meant to orient an agent or teammate quickly.

## Runtime Shape

- `apps/web` is the Next.js app. Server Components read from Postgres through Drizzle, and server actions mutate app state.
- WorkOS AuthKit handles identity. `getCurrentWorkspace()` resolves the signed-in user and workspace before app data is read or written.
- Neon Postgres is the immediate app source of truth. The shared DB client lives in `packages/db/src/client.ts`; the schema lives in `packages/db/src/schema.ts`.
- GitHub stores workspace state in a managed private repo per workspace. In the current app-authored flow it is an async mirror, not the blocking source for editor saves.
- Inngest runs background jobs. The app exposes `/api/inngest`, and local development runs the Inngest dev server through the `@opencompany/inngest-dev` workspace.
- `apps/runner` is the long-lived agent-session data plane. It provisions E2B sandboxes, runs the model/tool loop through Vercel AI Gateway and AI SDK Core, and writes replayable runtime events to Postgres.

## Agent Editing Flow

Agent pages read the `agents` table for the current workspace. The editor is a textarea-based client component with `@` mention suggestions for supported models and tools.

When an agent is created or edited:

1. `createAgent()` or `updateAgent()` in `apps/web/lib/agents/actions.ts` serializes the agent into the `.agent` file format.
2. The app stores the latest title, body, parsed config, content hash, and version in Postgres.
3. The same transaction upserts `agent_sync_jobs` with the desired hash/version and a `nextRunAt` about 10 seconds out.
4. After the response, the action dispatches `agent.sync_requested` to Inngest.
5. The UI treats the DB write as saved immediately and separately shows GitHub sync status.

The editor debounces saves by about 600ms in `AgentDetail.tsx`. Failed GitHub syncs should not make the editor look unsaved; they set `githubSyncStatus = failed` and keep the error on the agent row.

## Agent File Format

Workspace repos store agents as `agents/<slug>.agent` files. The format is a Markdown body with a YAML frontmatter header; the body is the source of truth and the frontmatter is derived from `@mention` tokens inside it.

For the full spec — fields, validation rules, supported models and tools, examples, and the compiled `AgentConfig` shape — see [agent-file.md](./agent-file.md).

The parser and serializer live in `apps/web/lib/agents/agent-file.ts`; the catalog of supported models and tools lives in `apps/web/lib/agents/config.ts`.

## GitHub Workspace State

GitHub logic lives in `apps/web/lib/workspace-state/github.ts`.

- Each workspace gets one managed private repo named from the workspace and id suffix.
- The repo record is cached in `workspace_repositories`.
- GitHub App credentials provide installation tokens; the token is cached in memory until close to expiry.
- Writes use the Contents API. The app reuses the last `githubBlobSha` when available, then refetches on content conflicts.
- `listWorkspaceAgentFiles()` and `readWorkspaceFile()` support manual GitHub-to-DB import through `syncAgentsFromWorkspaceRepository()`.

Current limitation: there is no GitHub webhook ingestion path. External GitHub edits are only reflected after an explicit sync-from-repository action.

## Agent Sessions

Agent sessions turn a saved `.agent` configuration into a live cloud run. The web app stays the
authenticated control plane, while `apps/runner` owns the long-lived data plane.

The important files are:

- `apps/web/lib/agent-sessions/actions.ts`: creates sessions, inserts user messages, signs stream
  tokens, and dispatches Inngest events.
- `apps/web/lib/agent-sessions/runner.ts`: server-to-server calls from web/Inngest to the runner.
- `apps/web/components/SessionView.tsx`: reads persisted messages and applies SSE events.
- `apps/runner/src/server.ts`: Fastify routes for health, internal mutations, and SSE.
- `apps/runner/src/agent-loop.ts`: E2B provisioning, AI SDK `streamText`, tool execution, and
  event writes.
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

`sync-agent-to-github` listens for `agent.sync_requested`, sleeps 10 seconds to coalesce rapid edits, then calls `materializeAgentToGitHub()`.

`materializeAgentToGitHub()`:

- loads the latest agent, workspace, and sync job from Postgres;
- defers if the job's `nextRunAt` is still in the future;
- no-ops and deletes the job if `githubSyncedHash` already matches the current hash;
- marks the agent `syncing`, writes the `.agent` file to GitHub, then marks it `synced`;
- records failure on both the agent and sync job, then rethrows so Inngest retries.

Inngest concurrency is limited to one active sync per `agentId`. There is no cron sweeper yet, so if the event dispatch after the DB write never reaches Inngest, another edit is currently the practical way to enqueue a fresh sync.

## Database Model

The high-level table groups are:

- Identity and tenancy: `users`, `workspaces`, `workspace_memberships`, with WorkOS Organizations mapped through `workspaces.workos_organization_id`.
- Agent editing: `agents` stores the latest DB version and parsed config.
- GitHub sync: `agent_sync_jobs` stores desired materialization state; `workspace_repositories` maps workspaces to managed GitHub repos.
- Agent sessions: `agent_sessions`, `agent_session_messages`, and `agent_session_events` store
  durable session ownership, transcript, and replayable streaming state.
- Onboarding: `onboarding_responses`.

All app-owned data should stay scoped by `workspaceId` so tenancy remains enforceable.

## Operational Notes

- `bun run dev` starts the web app, local Inngest dev helper, and runner.
- `bun run dev:web` runs only the web app.
- `bun run dev:runner` runs only the runner.
- `bun run db:generate` creates migrations from `packages/db/src/schema.ts`.
- `bun run db:migrate` applies migrations to `DATABASE_URL`.
- Production releases run migrations from the `Release Production` GitHub Actions workflow before
  deploying Vercel web and Render runner.
- GitHub workspace-state env vars are `OPENCOMPANY_GITHUB_ORG`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`.
- Inngest uses `INNGEST_DEV` for local development; hosted environments should also set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.
- Runner env vars are `RUNNER_PUBLIC_URL`, optional `RUNNER_INTERNAL_URL`,
  `RUNNER_INTERNAL_TOKEN`, `RUNNER_STREAM_TOKEN_SECRET`, `RUNNER_ALLOWED_ORIGINS`, `E2B_API_KEY`,
  `VERCEL_AI_GATEWAY_API_KEY`, optional `OPENCOMPANY_E2B_TEMPLATE`, and optional
  `RUNNER_E2B_IDLE_TIMEOUT_MS` / `RUNNER_INSTANCE_ID`.
