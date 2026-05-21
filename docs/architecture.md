# Architecture

This is the short map for coming back to the project after time away. Source files are still the source of truth; this page is meant to orient an agent or teammate quickly.

## Runtime Shape

- `apps/web` is the Next.js app. Server Components read from Postgres through Drizzle, and server actions mutate app state.
- WorkOS AuthKit handles identity. `getCurrentWorkspace()` resolves the signed-in user and workspace before app data is read or written.
- Neon Postgres is the immediate app source of truth. The shared DB client lives in `apps/web/lib/db/index.ts`; the schema lives in `apps/web/lib/db/schema.ts`.
- GitHub stores workspace state in a managed private repo per workspace. In the current app-authored flow it is an async mirror, not the blocking source for editor saves.
- Inngest runs background jobs. The app exposes `/api/inngest`, and local development runs the Inngest dev server through the `@opencompany/inngest-dev` workspace.

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

Workspace repos store agents under `agents/<slug>.agent`.

```yaml
---
title: "Research"
model: openai/gpt-5.4
tools:
  - exa
---

Find people with @exa and use @deep.
```

`apps/web/lib/agents/agent-file.ts` parses and serializes this format. The markdown body is what users edit. Frontmatter is deterministic metadata:

- `title` comes from the title input.
- `model` comes from the last supported model mention in the body, defaulting to `openai/gpt-5.4-mini`.
- `tools` are the unique supported tool mentions in the body.

Supported models/tools live in `apps/web/lib/agents/config.ts`. `@deep` maps to `openai/gpt-5.4`; `@fast` and `@default` map to `openai/gpt-5.4-mini`.

## GitHub Workspace State

GitHub logic lives in `apps/web/lib/workspace-state/github.ts`.

- Each workspace gets one managed private repo named from the workspace and id suffix.
- The repo record is cached in `workspace_repositories`.
- GitHub App credentials provide installation tokens; the token is cached in memory until close to expiry.
- Writes use the Contents API. The app reuses the last `githubBlobSha` when available, then refetches on content conflicts.
- `listWorkspaceAgentFiles()` and `readWorkspaceFile()` support manual GitHub-to-DB import through `syncAgentsFromWorkspaceRepository()`.

Current limitation: there is no GitHub webhook ingestion path. External GitHub edits are only reflected after an explicit sync-from-repository action.

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

- Identity and tenancy: `users`, `workspaces`, `workspace_memberships`.
- Agent editing: `agents` stores the latest DB version and parsed config.
- GitHub sync: `agent_sync_jobs` stores desired materialization state; `workspace_repositories` maps workspaces to managed GitHub repos.
- Onboarding: `onboarding_responses`.

All app-owned data should stay scoped by `workspaceId` so tenancy remains enforceable.

## Operational Notes

- `bun run dev` starts the web app and local Inngest dev helper.
- `bun run dev:web` runs only the web app.
- `bun run db:generate` creates migrations from `apps/web/lib/db/schema.ts`.
- `bun run db:migrate` applies migrations to `DATABASE_URL`.
- GitHub workspace-state env vars are `OPENCOMPANY_GITHUB_ORG`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`.
- Inngest uses `INNGEST_DEV` for local development; hosted environments should also set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.
