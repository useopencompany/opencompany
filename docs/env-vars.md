# Environment Variables

This is the operational map for where each env var lives. Infisical is the source of truth; Vercel,
Render, and GitHub Actions receive values from Infisical syncs or runtime OIDC fetches.
`.env.example` remains the template for local development; this page is the production/reference
view.

## Environments

| Place | Purpose | Managed in |
|---|---|---|
| Local `.env.override.local` | Developer-owned local overrides | `bun run setup:personal`; never committed |
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
| `RUNNER_PUBLIC_URL` | Vercel, GitHub Actions | Browser-reachable Render URL. |
| `RUNNER_ALLOWED_ORIGINS` | Render, production web domain | Must include the exact Vercel production origin if browser-origin runner requests are enabled. |
| `DURABLE_STREAMS_URL` / `DURABLE_STREAMS_TOKEN` | Vercel, Render | Web owns the read proxy and web-authored appends; runner owns model/tool appends. |
| `GITHUB_APP_ID` | Vercel, Render | Same GitHub App for workspace repos and runner Brain sync. |
| `GITHUB_APP_INSTALLATION_ID` | Vercel, Render | Managed workspace-state installation target used for workspace repo writes and runner Brain sync. |
| `GITHUB_APP_PRIVATE_KEY` | Vercel, Render | Same private key, with newlines preserved or escaped as `\n`. |
| `GITHUB_INTEGRATION_APP_ID` | Vercel, Render | Separate GitHub App for user-facing repository integrations. |
| `GITHUB_INTEGRATION_APP_PRIVATE_KEY` | Vercel, Render | Integration app private key, with newlines preserved or escaped as `\n`. |
| `GITHUB_INTEGRATION_APP_SLUG` | Vercel web envs | Integration GitHub App slug. |
| `GITHUB_INTEGRATION_APP_CLIENT_ID` | Vercel web envs | Integration GitHub App OAuth client id. |
| `GITHUB_INTEGRATION_APP_CLIENT_SECRET` | Vercel web envs | Integration GitHub App OAuth client secret. |
| `GITHUB_INTEGRATION_STATE_SECRET` | Vercel web envs | 32+ character secret used only to sign GitHub integration OAuth state. |
| `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` | Vercel web envs | Base64-encoded 32-byte key used to encrypt workspace provider credentials stored in Neon. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Vercel, Render | Google OAuth client shared by the Gmail and Google Calendar integrations. Redirect URIs: `${NEXT_PUBLIC_APP_URL}/api/integrations/gmail/callback` and `.../api/integrations/google-calendar/callback`. The runner also needs these to refresh access tokens. |
| `GOOGLE_INTEGRATION_STATE_SECRET` | Vercel web envs | 32+ character secret used only to sign Google integration OAuth state. |
| `MCP_OAUTH_STATE_SECRET` | Vercel web envs | 32+ character secret used only to sign MCP OAuth setup state. Separate from the credential encryption key. |
| `SLACK_MCP_CLIENT_ID` / `SLACK_MCP_CLIENT_SECRET` | Vercel, Render | Slack hosted MCP OAuth app credentials. |
| `OBSERVABILITY_RELEASE` | Vercel, Render | Manual override only. Normal hosted deploys should use Vercel/Render commit metadata and leave this unset. |

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
| `GITHUB_APP_INSTALLATION_ID` | Yes | Managed workspace-state GitHub App installation id. Do not use this as the user-facing work integration installation. |
| `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub App private key. |
| `GITHUB_INTEGRATION_APP_ID` | Yes | GitHub App id for user-facing repository integrations. |
| `GITHUB_INTEGRATION_APP_PRIVATE_KEY` | Yes | Integration app private key. |
| `GITHUB_INTEGRATION_APP_SLUG` | Yes | Integration app slug used to start workspace-level installation. |
| `GITHUB_INTEGRATION_APP_CLIENT_ID` | Yes | Integration app OAuth client id used to verify setup redirects. |
| `GITHUB_INTEGRATION_APP_CLIENT_SECRET` | Yes | Integration app OAuth client secret. |
| `GITHUB_INTEGRATION_STATE_SECRET` | Yes | Dedicated secret used to sign setup state. Generate a separate 32+ character value. |
| `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` | Yes | Base64-encoded 32-byte key used to encrypt workspace provider and MCP credentials in Neon. Generate with `openssl rand -base64 32`. |
| `GOOGLE_OAUTH_CLIENT_ID` | Google only | Google OAuth client id (Gmail + Calendar integrations). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google only | Google OAuth client secret. |
| `GOOGLE_INTEGRATION_STATE_SECRET` | Google only | Dedicated secret used to sign Google OAuth setup state. Generate a separate 32+ character value. |
| `MCP_OAUTH_STATE_SECRET` | MCP only | Dedicated secret used to sign MCP OAuth setup state. Generate a separate 32+ character value with `openssl rand -base64 32`. |
| `SLACK_MCP_CLIENT_ID` | MCP only | Slack hosted MCP OAuth client id. Callback URL: `${NEXT_PUBLIC_APP_URL}/api/mcp/slack/callback`. |
| `SLACK_MCP_CLIENT_SECRET` | MCP only | Slack hosted MCP OAuth client secret. Stored only in env, not in Neon. |
| `SLACK_SUPPORT_BOT_TOKEN` | Slack Connect only | `xoxb-…` bot token for OC's own support Slack app. The Inngest provisioning function runs on the web deployment, so this lives here (not the runner). Server-only, never `NEXT_PUBLIC`. Empty = feature disabled (no-ops to `failed`, onboarding never crashes). Distinct from `SLACK_MCP_*`. |
| `SLACK_SUPPORT_TEAM_ID` | Slack Connect only | OC Slack workspace/team id (`T…`), denormalized for link building. |
| `SLACK_SUPPORT_MEMBER_IDS` | Slack Connect only | Comma-separated `U…` ids of OC support members auto-invited to each channel. |
| `INNGEST_EVENT_KEY` | Hosted only | Sends events to Inngest Cloud. Not needed for local dev. |
| `INNGEST_SIGNING_KEY` | Hosted only | Verifies Inngest requests to `/api/inngest`. Not needed for local dev. |
| `INNGEST_DEV` | No | Do not set in hosted envs. Local dev only. |
| `RUNNER_PUBLIC_URL` | Yes | Browser-reachable Render runner URL. |
| `RUNNER_INTERNAL_URL` | No | Server-to-server runner URL. Defaults to `RUNNER_PUBLIC_URL`. |
| `RUNNER_INTERNAL_TOKEN` | Yes | Bearer token for runner internal endpoints. |
| `ELECTRIC_URL` | Yes | Electric shape service base URL. |
| `ELECTRIC_SOURCE_ID` | Electric Cloud only | Electric Cloud source id. |
| `ELECTRIC_SOURCE_SECRET` | Electric Cloud only | Electric Cloud source secret. |
| `ELECTRIC_TOKEN` | Self-hosted Electric only | Bearer token for protected self-hosted Electric. |
| `DURABLE_STREAMS_URL` | Yes | Durable Streams base URL for session transcript reads and web-authored appends. |
| `DURABLE_STREAMS_TOKEN` | Yes | Bearer token for the Durable Streams service. Server-only; never exposed to the browser. |
| `LINEAR_API_KEY` | No | Enables feedback intake. |
| `LINEAR_TEAM_ID` | No | Linear team for feedback. |
| `LINEAR_FEEDBACK_PROJECT_ID` | No | Optional project routing for feedback. |
| `LINEAR_FEEDBACK_LABELS` | No | Optional comma-separated labels. |
| `RESEND_API_KEY` | No | Enables transactional email through Resend. Missing values disable email sends. |
| `RESEND_WELCOME_FROM` | No | Sender identity for the signup welcome email. Defaults to `Louis from OpenCompany <louis@opencompany.cloud>`. |
| `RESEND_REPLY_TO` | No | Reply-to address for transactional emails. Defaults to `louis@opencompany.cloud`. |
| `RESEND_REGISTERED_USERS_SEGMENT_ID` | Required with `RESEND_API_KEY` | Resend Segment ID for the `Registered Users` Segment. Create the Segment in Resend and store its ID in Infisical/Vercel before enabling Resend. |
| `NEXT_PUBLIC_POSTHOG_TOKEN` | No | Enables PostHog client/server analytics. |
| `NEXT_PUBLIC_POSTHOG_HOST` | No | PostHog host. |
| `NEXT_PUBLIC_ANALYTICS_DEBUG` | No | Local/debug analytics logging. |
| `OBSERVABILITY_ENABLED` | No | Server observability toggle. |
| `OBSERVABILITY_ENV` | No | Server observability environment. |
| `OBSERVABILITY_RELEASE` | No | Manual server release override. Vercel git SHA wins when available. |
| `OBSERVABILITY_LOG_LEVEL` | No | Structured logger level. |
| `OBSERVABILITY_TIMING` | No | Verbose timing logs. |
| `OPENCOMPANY_TIMING` | No | Legacy timing alias. |
| `BRAINTRUST_ENABLED` | No | Enables Braintrust runner tracing when set to `true`, `1`, `on`, or `yes`. |
| `BRAINTRUST_API_KEY` | Required with `BRAINTRUST_ENABLED` | Braintrust API key for runner traces. |
| `BRAINTRUST_PROJECT_ID` | No | Braintrust project UUID for runner traces. Takes precedence over `BRAINTRUST_PROJECT_NAME`. |
| `BRAINTRUST_PROJECT_NAME` | No | Braintrust project name for runner traces. Defaults to `OpenCompany Runner`. |
| `BETTER_STACK_ERRORS_DSN` | No | Server-side error capture DSN override. |
| `NEXT_PUBLIC_OBSERVABILITY_ENABLED` | No | Browser observability toggle. |
| `NEXT_PUBLIC_OBSERVABILITY_ENV` | No | Browser observability environment. |
| `NEXT_PUBLIC_OBSERVABILITY_RELEASE` | No | Browser release tag. Production release workflow sets this from the released commit during build. |
| `NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL` | No | Browser log level. |
| `NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN` | No | Browser and fallback server error DSN. |

## Render Runner

Set these in the Render `opencompany-runner` service.

| Var | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Hosted only | Same hosted Neon database used by web. Do not store this in Infisical `dev`; local setup writes branch DB URLs to `.env.local`. |
| `RUNNER_INTERNAL_TOKEN` | Yes | Must match Vercel. |
| `RUNNER_STREAM_TOKEN_SECRET` | Yes | Runner signing secret used for hosted-tool polling job ids. |
| `RUNNER_ALLOWED_ORIGINS` | Yes | Comma-separated browser origins allowed for runner requests. |
| `DURABLE_STREAMS_URL` | Yes | Durable Streams base URL for model/tool transcript appends. Must match Vercel. |
| `DURABLE_STREAMS_TOKEN` | Yes | Bearer token for the Durable Streams service. Must match Vercel. |
| `E2B_API_KEY` | Yes | Creates/connects E2B sandboxes. |
| `VERCEL_AI_GATEWAY_API_KEY` | Yes | Model calls through Vercel AI Gateway. |
| `EXA_API_KEY` | No | Required only for agents that enable Exa. |
| `X_API_BEARER_TOKEN` | No | Required only for agents that enable the X read-only hosted tool. |
| `APIFY_API_TOKEN` | No | Required only for agents that enable Apify-backed Instagram or TikTok profile/feed/comment/search tools. |
| `SUPADATA_API_KEY` | No | Required only for agents that enable Supadata-backed YouTube tools or TikTok/Instagram direct-media transcript/metadata tools. |
| `OPENCOMPANY_E2B_TEMPLATE` | No | Optional custom E2B template. |
| `AMP_API_KEY` | AMP only | Platform AMP credential used by the runner when agents enable the AMP coding tool. |
| `OPENCOMPANY_AMP_E2B_TEMPLATE` | No | Optional AMP-specific E2B template; defaults to `amp`. |
| `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` | Yes | Decrypts workspace MCP and Google (Gmail/Calendar) credentials. Validated at runner boot — the runner fails to start if it is missing or malformed. Must match Vercel. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google only | Used by the runner to refresh Gmail/Calendar access tokens against Google's token endpoint. Must match Vercel. |
| `SLACK_MCP_CLIENT_ID` | MCP only | Slack hosted MCP OAuth client id. Must match Vercel. |
| `SLACK_MCP_CLIENT_SECRET` | MCP only | Slack hosted MCP OAuth client secret. Must match Vercel. |
| `RUNNER_E2B_IDLE_TIMEOUT_MS` | No | Sandbox idle timeout, defaults to `30000`. |
| `RUNNER_WORKER_CONCURRENCY` | No | Max parallel sessions per instance, defaults to `8` (prod 40). Bounded by the event loop + E2B sandbox quota + gateway rate limits, not CPU/RAM. |
| `RUNNER_INSTANCE_ID` | No | Stable runner identity for hosted deployments. |
| `GITHUB_APP_ID` | Yes | Enables runner Brain sync to GitHub. |
| `GITHUB_APP_INSTALLATION_ID` | Yes | Enables runner Brain sync to GitHub. |
| `GITHUB_APP_PRIVATE_KEY` | Yes | Enables runner Brain sync to GitHub. |
| `GITHUB_INTEGRATION_APP_ID` | Yes for AMP | Enables runner cloning and PR creation for connected work repositories. |
| `GITHUB_INTEGRATION_APP_PRIVATE_KEY` | Yes for AMP | Enables runner installation tokens for connected work repositories. |
| `BETTER_STACK_ERRORS_DSN` | No | Runner error capture DSN. |
| `OBSERVABILITY_ENABLED` | No | Runner observability toggle. |
| `OBSERVABILITY_ENV` | No | Runner observability environment. |
| `OBSERVABILITY_RELEASE` | No | Manual runner release override. Render git SHA wins when available. |
| `OBSERVABILITY_LOG_LEVEL` | No | Runner log level. |
| `OBSERVABILITY_TIMING` | No | Verbose timing logs. |
| `BRAINTRUST_ENABLED` | No | Enables Braintrust runner tracing when set to `true`, `1`, `on`, or `yes`. |
| `BRAINTRUST_API_KEY` | Required with `BRAINTRUST_ENABLED` | Braintrust API key for runner traces. |
| `BRAINTRUST_PROJECT_ID` | No | Braintrust project UUID for runner traces. Takes precedence over `BRAINTRUST_PROJECT_NAME`. |
| `BRAINTRUST_PROJECT_NAME` | No | Braintrust project name for runner traces. Defaults to `OpenCompany Runner`. |

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
| `RENDER_SERVICE_ID` | Render service id for `opencompany-runner`. |
| `RENDER_API_KEY` | Render API key used to trigger and poll runner deploys. |
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
| `RENDER_DEPLOY_TIMEOUT_MS` | No | Maximum time to wait for the Render deploy API before smoke checks. Defaults to `900000`. |
| `RENDER_DEPLOY_POLL_MS` | No | Delay between Render deploy status polls. Defaults to `10000`. |
| `SMOKE_WEB` | No | Set to `false`, `0`, or `no` to skip web health checks. Defaults to enabled. |
| `SMOKE_RUNNER` | No | Set to `false`, `0`, or `no` to skip runner health checks. Defaults to enabled. |
| `SMOKE_ATTEMPTS` | No | Default health retry count. Defaults to `30`. |
| `SMOKE_WEB_ATTEMPTS` | No | Web health retry count. Falls back to `SMOKE_ATTEMPTS`; workflow uses `12`. |
| `SMOKE_RUNNER_ATTEMPTS` | No | Runner health retry count. Falls back to `SMOKE_ATTEMPTS`; workflow uses `12`. |
| `SMOKE_DELAY_MS` | No | Delay between retries. Defaults to `10000`. |

## Local Development

Personal overrides can be created with:

```bash
bun run setup:personal
```

`.env.override.local` is gitignored and has higher precedence than `.env.local`. Use it for
developer-owned resources such as a personal Neon project id or a local-only GitHub org override.
Do not put shared team secrets there; keep shared dev values in Infisical.

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
| `OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS` | Comma-separated emails that skip onboarding locally. Ignored in production, CI, and hosted Vercel runtimes. Local setup/export scripts seed this value when missing. |
| `NEON_PROJECT_ID` | Required for local Neon branch automation. |
| `NEON_API_KEY` | Optional for headless Neon CLI usage. |
| `NEON_PARENT_BRANCH` | Optional parent branch for local Neon branches. |
| `NEON_BRANCH_NAME` | Optional override when multiple worktrees share a Git branch. |
| `NEON_BRANCH_TTL_HOURS` | Optional local Neon branch lifetime in hours. Defaults to `24`; use `0` to disable expiration. |
| `NEON_DATABASE_NAME` | Optional nonstandard Neon database name. |
| `NEON_ROLE_NAME` | Optional nonstandard Neon role. |
| `PORT` | Optional local web port override. |
| `INNGEST_SDK_URL` | Optional local Inngest SDK URL override. |
| `OPENCOMPANY_NGROK_URL` | Optional stable ngrok origin for local integration callback testing. |
| `NGROK_AUTHTOKEN` | Optional ngrok auth token for local dev. Prefer the local ngrok config unless sharing through Infisical. |
| `OPENCOMPANY_NGROK_REQUIRED` | Set to `1` to fail `bun run dev` when ngrok cannot start. Fixed ngrok URLs are treated as required. |
| `OPENCOMPANY_NGROK_DISABLED` | Set to `1` to skip automatic ngrok startup in `bun run dev`. |
| `PLAYWRIGHT_PORT` | Optional Playwright web server port. |

For local GitHub integration testing, `bun run dev` starts ngrok automatically when the local ngrok
CLI is authenticated. It injects `NEXT_PUBLIC_APP_URL` and `RUNNER_ALLOWED_ORIGINS` into the dev
process without changing `.env.local`. Local WorkOS redirects stay on
`http://localhost:3000/auth/callback`; use `bun run github:tunnel` when you need to persist a tunnel
origin to `.env.local`.

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
