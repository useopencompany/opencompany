# Data and State

## Neon Postgres

**What it is:** Managed serverless Postgres.

**What it does for us:** Stores product data for users, workspaces, agents, GitHub sync state,
agent sessions, runtime events, billing credits, and onboarding state. Local development uses
branch-specific Neon databases by default.

**Where it is used:**

- `DATABASE_URL` in `.env.example`.
- `packages/db/src/client.ts`.
- `packages/db/src/schema.ts`.
- `scripts/neon-branch.mjs`.
- `docs/database.md`.

**Why we use it:** Postgres is the right default data model for a multi-tenant app, and Neon
branching gives each worktree isolated schema/data changes without heavy local database setup.

**Owner:** Platform.

**Reconsider if:** We need tighter operational control, dedicated VPC networking, predictable
high-volume pricing, or database features better served by self-managed Postgres/RDS.

## Drizzle

**What it is:** TypeScript ORM and migration toolkit.

**What it does for us:** Defines typed tables and relations, powers app queries, and generates
checked-in SQL migrations.

**Where it is used:**

- `packages/db/src/schema.ts`.
- `packages/db/drizzle.config.ts`.
- `drizzle/`.
- `bun run db:generate`.
- `bun run db:migrate`.

**Why we use it:** Drizzle keeps schema and queries close to TypeScript while still producing SQL
migrations we can review and run explicitly in production.

**Owner:** Platform.

**Reconsider if:** Migration safety, query complexity, or relational modeling needs exceed what
Drizzle handles cleanly; or the team needs a more batteries-included ORM workflow.

## GitHub App

**What it is:** GitHub integration authenticated as an app installation.

**What it does for us:** Creates and writes to managed private workspace repositories. GitHub is the
source of truth for `.agent` files; Postgres stores the latest app state and sync job state.

**Where it is used:**

- `apps/web/lib/workspace-state/github.ts`.
- `apps/runner/src/github.ts`.
- `OPENCOMPANY_GITHUB_ORG`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`,
  `GITHUB_APP_PRIVATE_KEY` in `.env.example`.
- `docs/architecture.md`.
- `docs/agent-file.md`.

**Why we use it:** Agents are intended to be user-owned plain text files with Git history. A GitHub
App gives us installation-scoped access without using personal tokens.

**Owner:** Product Engineering.

**Reconsider if:** Customers need GitLab/Bitbucket/self-hosted Git support, GitHub API limits become
a bottleneck, or the product needs a storage abstraction beyond GitHub.

## Inngest

**What it is:** Event-driven background job platform.

**What it does for us:** Coordinates asynchronous work that should not block the UI, especially
agent sync jobs and message-run dispatch from the web app to the runner.

**Where it is used:**

- `apps/web/lib/inngest/client.ts`.
- `apps/web/lib/inngest/functions.ts`.
- `apps/web/app/api/inngest/route.ts`.
- `apps/inngest-dev`.
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_DEV` in `.env.example`.

**Why we use it:** Agent saves and message submissions need durable background orchestration without
turning the web request path into a queue worker.

**Owner:** Platform.

**Reconsider if:** The runner absorbs more orchestration, we need stronger workflow semantics, or
Inngest retry/visibility behavior stops matching production needs.

## Repo-owned state packages

These are not third-party technologies, but they are architectural boundaries:

- `@opencompany/db` owns database schema/client exports.
- `@opencompany/agent-runtime` owns agent runtime configuration, tool definitions, model catalog,
  and stream tokens.
- `@opencompany/billing` owns credit accounting and model usage cost helpers.
- `@opencompany/analytics` owns the event registry and PostHog facade.
- `@opencompany/observability` owns logging/capture facades.

**Why they exist:** Shared packages keep app, runner, scripts, and tests from importing across app
boundaries or duplicating product contracts.

**Owner:** Platform for boundaries; feature owners for package-specific behavior.

**Reconsider if:** A package becomes a thin pass-through with no clear ownership, or shared code
starts hiding product coupling that should be explicit.
