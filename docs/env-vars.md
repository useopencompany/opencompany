# Environment Variables

This is the operational map for where each env var lives. Infisical is the source of truth; Vercel,
Render, and GitHub Actions receive values from Infisical syncs or runtime OIDC fetches.
`.env.example` remains the template for local development; this page is the production/reference
view.

## Environments

| Place | Purpose | Managed in |
|---|---|---|
| Local `.env.local` | Developer machine and agent worktrees | `bun run setup`, backed by Infisical dev shared values |
| Vercel Development | Optional Vercel dev/preview runtime target | Infisical `dev` + `/web` sync |
| Vercel Preview | Preview web deployments | Infisical `staging` + `/web` sync |
| Vercel Production | Production web app and Inngest endpoint | Infisical `prod` + `/web` sync |
| Render Production | Production runner service | Infisical `prod` + `/runner` sync |
| GitHub Actions `production` | Release workflow migrations/deploy orchestration | Infisical OIDC fetch from `prod` + `/release` |

See [secret-management.md](./secret-management.md) for the Infisical setup and sync checklist.

## Must Match Across Services

These values are cross-service contracts. Treat drift as a deploy blocker.

| Var | Must match between | Notes |
|---|---|---|
| `DATABASE_URL` / `PRODUCTION_DATABASE_URL` | Hosted Vercel, Render, GitHub Actions | Same hosted Neon database. GitHub uses `PRODUCTION_DATABASE_URL`; apps read `DATABASE_URL`. Local dev gets `DATABASE_URL` from `.env.local` Neon branch setup. |
| `RUNNER_INTERNAL_TOKEN` | Vercel, Render | Web/Inngest uses it to call runner internal endpoints. |
| `RUNNER_STREAM_TOKEN_SECRET` | Vercel, Render | Web signs browser SSE tokens; runner verifies them. |
| `RUNNER_PUBLIC_URL` | Vercel, GitHub Actions | Browser-reachable Render URL. |
| `RUNNER_ALLOWED_ORIGINS` | Render, production web domain | Must include the exact Vercel production origin. |
| `GITHUB_APP_ID` | Vercel, Render | Same GitHub App for workspace repos and runner cloning. |
| `GITHUB_APP_INSTALLATION_ID` | Vercel, Render | Same installation target. |
| `GITHUB_APP_PRIVATE_KEY` | Vercel, Render | Same private key, with newlines preserved or escaped as `\n`. |
| `OBSERVABILITY_RELEASE` | Vercel, Render | Optional when platform git SHA vars are available, but useful for manual deploys. |

## Vercel Web

Set these in Vercel Production.

| Var | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Hosted only | Hosted Neon pooled connection string. Do not store this in Infisical `dev`; local setup writes branch DB URLs to `.env.local`. |
| `WORKOS_CLIENT_ID` | Yes | WorkOS AuthKit client id. |
| `WORKOS_API_KEY` | Yes | WorkOS server API key. |
| `WORKOS_COOKIE_PASSWORD` | Yes | AuthKit cookie encryption secret, 32+ characters. |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | Yes | Production callback URL. Must match WorkOS dashboard. |
| `WORKOS_REDIRECT_URI` | No | Server-only fallback. Usually leave unset. |
| `OPENCOMPANY_GITHUB_ORG` | Yes | GitHub org where workspace repos are created. |
| `GITHUB_APP_ID` | Yes | GitHub App id. |
| `GITHUB_APP_INSTALLATION_ID` | Yes | GitHub App installation id. |
| `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub App private key. |
| `INNGEST_EVENT_KEY` | Hosted only | Sends events to Inngest Cloud. Not needed for local dev. |
| `INNGEST_SIGNING_KEY` | Hosted only | Verifies Inngest requests to `/api/inngest`. Not needed for local dev. |
| `INNGEST_DEV` | No | Do not set in hosted envs. Local dev only. |
| `RUNNER_PUBLIC_URL` | Yes | Browser SSE URL for Render runner. |
| `RUNNER_INTERNAL_URL` | No | Server-to-server runner URL. Defaults to `RUNNER_PUBLIC_URL`. |
| `RUNNER_INTERNAL_TOKEN` | Yes | Bearer token for runner internal endpoints. |
| `RUNNER_STREAM_TOKEN_SECRET` | Yes | Signs runner SSE tokens. |
| `LINEAR_API_KEY` | No | Enables feedback intake. |
| `LINEAR_TEAM_ID` | No | Linear team for feedback. |
| `LINEAR_FEEDBACK_PROJECT_ID` | No | Optional project routing for feedback. |
| `LINEAR_FEEDBACK_LABELS` | No | Optional comma-separated labels. |
| `NEXT_PUBLIC_POSTHOG_TOKEN` | No | Enables PostHog client/server analytics. |
| `NEXT_PUBLIC_POSTHOG_HOST` | No | PostHog host. |
| `NEXT_PUBLIC_ANALYTICS_DEBUG` | No | Local/debug analytics logging. |
| `OBSERVABILITY_ENABLED` | No | Server observability toggle. |
| `OBSERVABILITY_ENV` | No | Server observability environment. |
| `OBSERVABILITY_RELEASE` | No | Server release tag. Falls back to Vercel git SHA. |
| `OBSERVABILITY_LOG_LEVEL` | No | Structured logger level. |
| `OBSERVABILITY_TIMING` | No | Verbose timing logs. |
| `OPENCOMPANY_TIMING` | No | Legacy timing alias. |
| `BETTER_STACK_ERRORS_DSN` | No | Server-side error capture DSN override. |
| `NEXT_PUBLIC_OBSERVABILITY_ENABLED` | No | Browser observability toggle. |
| `NEXT_PUBLIC_OBSERVABILITY_ENV` | No | Browser observability environment. |
| `NEXT_PUBLIC_OBSERVABILITY_RELEASE` | No | Browser release tag. |
| `NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL` | No | Browser log level. |
| `NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN` | No | Browser and fallback server error DSN. |

## Render Runner

Set these in the Render `opencompany-runner` service.

| Var | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Hosted only | Same hosted Neon database used by web. Do not store this in Infisical `dev`; local setup writes branch DB URLs to `.env.local`. |
| `RUNNER_INTERNAL_TOKEN` | Yes | Must match Vercel. |
| `RUNNER_STREAM_TOKEN_SECRET` | Yes | Must match Vercel. |
| `RUNNER_ALLOWED_ORIGINS` | Yes | Comma-separated browser origins allowed for SSE. |
| `E2B_API_KEY` | Yes | Creates/connects E2B sandboxes. |
| `VERCEL_AI_GATEWAY_API_KEY` | Yes | Model calls through Vercel AI Gateway. |
| `EXA_API_KEY` | No | Required only for agents that enable Exa. |
| `OPENCOMPANY_E2B_TEMPLATE` | No | Optional custom E2B template. |
| `RUNNER_E2B_IDLE_TIMEOUT_MS` | No | Sandbox idle timeout, defaults to `30000`. |
| `RUNNER_INSTANCE_ID` | No | Stable runner identity for hosted deployments. |
| `GITHUB_APP_ID` | Yes | Enables runner workspace cloning. |
| `GITHUB_APP_INSTALLATION_ID` | Yes | Enables runner workspace cloning. |
| `GITHUB_APP_PRIVATE_KEY` | Yes | Enables runner workspace cloning. |
| `BETTER_STACK_ERRORS_DSN` | No | Runner error capture DSN. |
| `OBSERVABILITY_ENABLED` | No | Runner observability toggle. |
| `OBSERVABILITY_ENV` | No | Runner observability environment. |
| `OBSERVABILITY_RELEASE` | No | Runner release tag. Falls back to Render git SHA. |
| `OBSERVABILITY_LOG_LEVEL` | No | Runner log level. |
| `OBSERVABILITY_TIMING` | No | Verbose timing logs. |

Render also injects `PORT` and `RENDER_GIT_COMMIT`; do not set them manually unless debugging.

## GitHub Actions Production

Use a protected GitHub environment named `production`. Store release secrets in Infisical `prod` +
`/release`; the workflow fetches them with OIDC at runtime.

Infisical `prod` + `/release` secrets:

| Name | Purpose |
|---|---|
| `PRODUCTION_DATABASE_URL` | Production Neon URL used by release migrations. |
| `VERCEL_TOKEN` | Vercel CLI deploy token. |
| `VERCEL_ORG_ID` | Vercel team/org id. |
| `VERCEL_PROJECT_ID` | Vercel project id. |
| `RENDER_DEPLOY_HOOK_URL` | Render deploy hook for `opencompany-runner`. |
| `PRODUCTION_WEB_URL` | Canonical production web URL for smoke checks. |
| `RUNNER_PUBLIC_URL` | Canonical production runner URL for smoke checks. |

GitHub environment variables:

| Name | Purpose |
|---|---|
| `INFISICAL_PROJECT_SLUG` | Infisical project slug. Safe to store as a GitHub environment variable. |
| `INFISICAL_MACHINE_IDENTITY_ID` | Infisical machine identity id. Safe to store as a GitHub environment variable. |
| `INFISICAL_ENV_SLUG` | Optional. Defaults to `prod`. |
| `INFISICAL_DOMAIN` | Optional. Defaults to `https://eu.infisical.com`. |

Release-only script vars:

| Var | Required | Purpose |
|---|---:|---|
| `EXPECTED_RELEASE` | No | Smoke check expects health endpoint release fields to start with this SHA. |
| `SMOKE_ATTEMPTS` | No | Default health retry count. Defaults to `30`. |
| `SMOKE_WEB_ATTEMPTS` | No | Web health retry count. Falls back to `SMOKE_ATTEMPTS`; workflow uses `12`. |
| `SMOKE_RUNNER_ATTEMPTS` | No | Runner health retry count. Falls back to `SMOKE_ATTEMPTS`; workflow uses `60`. |
| `SMOKE_DELAY_MS` | No | Delay between retries. Defaults to `10000`. |

## Local Development

Local `.env.local` is created by:

```bash
bun run setup
```

Or exported from Infisical:

```bash
bun run infisical:export
```

Useful local-only vars:

| Var | Purpose |
|---|---|
| `OPENCOMPANY_SHARED_DATABASE` | Escape hatch to use a shared `DATABASE_URL`. Prefer Neon branches. |
| `NEON_PROJECT_ID` | Required for local Neon branch automation. |
| `NEON_API_KEY` | Optional for headless Neon CLI usage. |
| `NEON_PARENT_BRANCH` | Optional parent branch for local Neon branches. |
| `NEON_BRANCH_NAME` | Optional override when multiple worktrees share a Git branch. |
| `NEON_DATABASE_NAME` | Optional nonstandard Neon database name. |
| `NEON_ROLE_NAME` | Optional nonstandard Neon role. |
| `PORT` | Optional local web port override. |
| `INNGEST_SDK_URL` | Optional local Inngest SDK URL override. |
| `PLAYWRIGHT_PORT` | Optional Playwright web server port. |

## Checks

Check local web and runner env coverage:

```bash
bun run release:preflight
```

Check only release automation env:

```bash
bun run infisical:release:preflight
```

Run deployed health checks:

```bash
PRODUCTION_WEB_URL=https://app.example.com \
RUNNER_PUBLIC_URL=https://opencompany-runner.onrender.com \
bun run release:smoke
```
