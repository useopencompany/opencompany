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
| Vercel Preview | Per-PR preview web base env | Infisical `dev` + `/web` sync; per-PR dynamic values injected at deploy time by `pr-preview.yml` |
| Vercel Production | Production web app and Inngest endpoint | Infisical `prod` + `/web` sync |
| Render Production | Production runner service | Infisical `prod` + `/runner` sync |
| Render Preview (per-PR) | Ephemeral per-PR runner / Electric / Durable Streams | Created by `scripts/preview-provision.mjs`; env minted by the orchestrator (not a static sync) |
| GitHub Actions `production` | Release workflow migrations/deploy orchestration | Infisical OIDC fetch from `prod` + `/release` |
| GitHub Actions `preview` | PR-preview provision/teardown + reaper | Infisical OIDC fetch from `dev` + `/release` (configurable) |

> **Preview environments** are a full per-PR isolated stack (Neon branch + runner + Electric + Durable Streams + Vercel web), label-gated on `preview`. See [deployment.md → PR preview environments](./deployment.md#pr-preview-environments) and the dedicated section below.

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
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Vercel, Render | Google OAuth client shared by the Gmail and Google Calendar integrations. Direct redirect URIs are `${NEXT_PUBLIC_APP_URL}/api/integrations/gmail/callback` and `.../api/integrations/google-calendar/callback`; hosted previews should use `GOOGLE_OAUTH_CALLBACK_URL` instead. The runner also needs these to refresh access tokens. |
| `GOOGLE_OAUTH_CALLBACK_URL` | Vercel web envs | Optional stable Google callback broker, e.g. `https://oauth.opencompany.cloud/api/google/callback`. When set, Google authorization and token exchange both use this exact redirect URI. |
| `GOOGLE_INTEGRATION_STATE_SECRET` | Vercel web envs | 32+ character secret used only to sign Google integration OAuth state. |
| `MCP_OAUTH_STATE_SECRET` | Vercel web envs | 32+ character secret used only to sign MCP OAuth setup state. Separate from the credential encryption key. |
| `SLACK_MCP_CLIENT_ID` / `SLACK_MCP_CLIENT_SECRET` | Vercel, Render | Slack hosted MCP OAuth app credentials. |
| `OBSERVABILITY_RELEASE` | Vercel, Render | Manual override only. Normal hosted deploys should use Vercel/Render commit metadata and leave this unset. |

## Vercel Web

Set these in Vercel Production.

| Var | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Hosted only | Hosted Neon pooled connection string. Do not store this in Infisical `dev`; local setup writes branch DB URLs to `.env.local`. |
| `VERCEL_AI_GATEWAY_API_KEY` | Yes | Fast-model calls made directly from web (e.g. tailored example pills on `/onboarding/personal`). Same key the runner uses. |
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
| `GOOGLE_OAUTH_CALLBACK_URL` | Google only | Optional stable callback broker URL for hosted previews, normally `https://oauth.opencompany.cloud/api/google/callback`. Leave unset for direct local callback behavior. |
| `GOOGLE_INTEGRATION_STATE_SECRET` | Google only | Dedicated secret used to sign Google OAuth setup state. Generate a separate 32+ character value. |
| `MCP_OAUTH_STATE_SECRET` | MCP only | Dedicated secret used to sign MCP OAuth setup state. Generate a separate 32+ character value with `openssl rand -base64 32`. |
| `SLACK_MCP_CLIENT_ID` | MCP only | Slack hosted MCP OAuth client id. Callback URL: `${NEXT_PUBLIC_APP_URL}/api/mcp/slack/callback`. |
| `SLACK_MCP_CLIENT_SECRET` | MCP only | Slack hosted MCP OAuth client secret. Stored only in env, not in Neon. |
| `SLACK_SUPPORT_BOT_TOKEN` | Slack Connect only | `xoxb-…` bot token for OC's own support Slack app. The Inngest provisioning function runs on the web deployment, so this lives here (not the runner). Server-only, never `NEXT_PUBLIC`. Empty = feature disabled (no-ops to `failed`, onboarding never crashes). Distinct from `SLACK_MCP_*`. |
| `SLACK_SUPPORT_TEAM_ID` | Slack Connect only | OC Slack workspace/team id (`T…`), denormalized for link building. |
| `SLACK_SUPPORT_MEMBER_IDS` | Slack Connect only | Comma-separated `U…` ids of OC support members auto-invited to each channel. |
| `INNGEST_EVENT_KEY` | Hosted only | Sends events to Inngest Cloud. Not needed for local dev. |
| `INNGEST_SIGNING_KEY` | Hosted only | Verifies Inngest requests to `/api/inngest`. Not needed for local dev. |
| `INNGEST_ENV` | Hosted preview only | Inngest branch environment name. PR previews set this dynamically to `preview-pr-<n>`. Leave unset in production. |
| `INNGEST_SERVE_ORIGIN` | Hosted preview only | Public origin Inngest should call for this deployment. PR previews set this dynamically to the deterministic preview custom domain. |
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
| `BETTER_STACK_PREVIEW_SOURCE_NAME` | No | Local/operator override for `bun run preview:debug-session` output. Defaults to `opencompany-runner-preview`; not a source token. |
| `NEXT_PUBLIC_OBSERVABILITY_ENABLED` | No | Browser observability toggle. |
| `NEXT_PUBLIC_OBSERVABILITY_ENV` | No | Browser observability environment. |
| `NEXT_PUBLIC_OBSERVABILITY_RELEASE` | No | Browser release tag. Production release workflow sets this from the released commit during build. |
| `NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL` | No | Browser log level. |
| `NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN` | No | Browser and fallback server error DSN. |

## Slack support channel (Slack Connect)

`SLACK_SUPPORT_*` power the post-onboarding Slack Connect channel (see the Vercel Web table
above). They live in **Infisical `prod` + `/web`** (synced to Vercel `opencompany-web`
Production — *not* `opencompany-dashboard`), because the Inngest provisioning function runs on
the web deployment.

Setup checklist:

1. Create a Slack app for OC's own support workspace (api.slack.com/apps → From scratch).
2. Bot Token Scopes: `groups:write` (create the private channel, invite members, stamp the
   ownership purpose), `groups:read` (adopt this workspace's own channel on a `name_taken`
   retry instead of duplicating), `chat:write` (intro message), `conversations.connect:write`
   (the external customer invite).
3. Install to the workspace → copy the Bot User OAuth Token (`xoxb-…`) → `SLACK_SUPPORT_BOT_TOKEN`.
4. `SLACK_SUPPORT_TEAM_ID` = the host workspace team id (`T…`); derive via `auth.test`.
5. `SLACK_SUPPORT_MEMBER_IDS` = comma-separated `U…` of the OC support people to auto-add to
   every customer channel (private channels are only visible to their members).
6. The host Slack workspace must be on a **paid plan** (Pro or a Pro trial). Slack Connect
   shared channels are unavailable on Free — `conversations.inviteShared` errors `not_paid`.

If `SLACK_SUPPORT_BOT_TOKEN` is empty the feature is disabled: provisioning no-ops to `failed`
and the workspace-home card degrades to the booking fallback (onboarding never breaks).

Channel naming: each customer channel is `<customer-slug>-<id8>-x-opencompany` (the
`-x-opencompany` convention plus a short per-workspace suffix so two same-named customers
practically never collide). Ownership is also stamped in the channel purpose
(`opencompany-support:<workspaceId>`) and checked before adopting on a retry, so a channel is
never hijacked across workspaces.

Recovery: an hourly Inngest cron (`sweep-failed-slack-support-channels`) re-dispatches
provisioning for workspaces stuck in `failed` or `pending` — so a transient failure, or a
workspace onboarded *before* `SLACK_SUPPORT_*` was configured, self-heals on the next sweep
(no manual backfill). It waits ~15 min before retrying a failure (so the provisioning function's
own Inngest retries run first), gives up on failures older than 7 days, and drains oldest-first.

### Testing & operations

- **Delivery:** `conversations.inviteShared` returns no shareable `url`, so Slack delivers the
  invite itself — by **email** to recipients without a Slack account, **in-app** (under "Slack
  Connect" invitations) to those who have one. The card therefore says "check your email"; both
  paths reach the customer. The invitee chooses which of *their* Slack orgs to file the shared
  channel into.
- **Visibility:** the channel is private — only its members see it. `SLACK_SUPPORT_MEMBER_IDS`
  must list the OC support people, or no human (only the bot) will see the channels. Being a
  workspace member is not enough.
- **Testing a fresh onboarding:** a Google-Workspace **plus-alias** (`you+test@domain`) receives
  mail but is **not** a Google account, so it can't complete Google SSO login. To re-test with a
  real account, reset the user (full delete is blocked by an FK): `delete from
  workspace_slack_channels where workspace_id=:ws; delete from onboarding_responses where
  user_id=:u; delete from agents where workspace_id=:ws and path='agents/leo/leo.agent';` then
  re-onboard.
- **Sandbox:** don't test against the real customer-facing Slack in a way that spams colleagues —
  use a Pro-trial workspace and set `SLACK_SUPPORT_MEMBER_IDS` to just yourself.

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
| `RUNNER_TOOL_ARG_REPAIR_ENABLED` | No | Kill switch for the model-based deferred-tool argument repair fallback (Layer 3). Deterministic validation + coercion always run; this only gates the small-model repair. Defaults to `true`. |
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

## Preview Environments (per-PR)

These power the label-gated per-PR preview stack (issue #351). They are read by the
`pr-preview.yml` / `preview-reaper.yml` workflows and the `scripts/preview-*.mjs` scripts.
Provision/orchestration credentials are fetched from Infisical (`dev` + `/release` by
default, configurable). Runner static runtime secrets are fetched separately from
Infisical (`prod` + `/runner` by default while previews reuse production service keys).
The web/runner/electric preview-specific runtime values are minted per-PR by the
orchestrator and are not stored anywhere long-term.

### GitHub Actions `preview` environment — repo variables (`vars.*`)

| Var | Required | Notes |
|---|---|---|
| `PREVIEW_BASE_DOMAIN` | Yes | Wildcard preview domain attached to the Vercel project, e.g. `preview.opencompany.cloud`. Alias = `pr-<n>.<domain>`. |
| `PREVIEW_INFISICAL_ENV_SLUG` | No | Infisical env for provision creds. Defaults to `dev`. |
| `PREVIEW_INFISICAL_SECRET_PATH` | No | Infisical path for provision creds. Defaults to `/release`. |
| `PREVIEW_RUNNER_INFISICAL_ENV_SLUG` | No | Infisical env for runner runtime secrets. Defaults to `prod`. |
| `PREVIEW_RUNNER_INFISICAL_SECRET_PATH` | No | Infisical path for runner runtime secrets. Defaults to `/runner`. |
| `PREVIEW_SEED_BRANCH` | No | Neon branch to fork previews from. Defaults to `preview-seed`. |
| `PREVIEW_NEON_TTL_HOURS` | No | Neon branch TTL backstop. Defaults to `24`. |
| `PREVIEW_MAX_AGE_HOURS` | No | Reaper hard max age for any preview resource. Defaults to `24`. |
| `PREVIEW_RENDER_REGION` | No | Render region for per-PR services. Defaults to `frankfurt`. |
| `PREVIEW_RENDER_PLAN` | No | Render instance plan. Defaults to `starter`. |
| `PREVIEW_ELECTRIC_STORAGE_DIR` | No | Persistent volume mount for Electric's shape log. Unset = ephemeral (reprovision-on-restart). |
| `INFISICAL_MACHINE_IDENTITY_ID`, `INFISICAL_PROJECT_SLUG` | Yes | OIDC identity for the preview env (same as production env vars). |

### Provision credentials (Infisical `dev` + `/release`, fetched via OIDC)

| Var | Used by | Notes |
|---|---|---|
| `NEON_API_KEY`, `NEON_PROJECT_ID` | provision/teardown/reaper | Branch create/delete + endpoint verification. |
| `RENDER_API_KEY` | provision/teardown/reaper | Create/destroy per-PR Render services. Same key model as the prod release CI. |
| `RENDER_OWNER_ID` | provision (optional) | Workspace/owner id for create-service. Auto-resolved from the API when the key has a single workspace; only set it if the key spans multiple. |
| `PREVIEW_RENDER_LOG_ENDPOINT`, `PREVIEW_RENDER_LOG_TOKEN` | preview log stream automation | Shared Better Stack Render syslog endpoint and source token for preview runner logs. Keep the token secret. |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | pr-preview.yml | Vercel build/deploy/alias. |

### Runner runtime credentials (Infisical `prod` + `/runner`, fetched via OIDC)

| Var | Used by | Notes |
|---|---|---|
| `E2B_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` | runner | Required at runner boot. The encryption key must match web so preview runners can read seeded encrypted integration credentials. |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | runner | Enables runner Brain sync. |
| `GITHUB_INTEGRATION_APP_ID`, `GITHUB_INTEGRATION_APP_PRIVATE_KEY` | runner | Enables connected-repository GitHub operations. |
| Optional runner tool/provider keys | runner | `EXA_API_KEY`, `APIFY_API_TOKEN`, `X_API_BEARER_TOKEN`, `SUPADATA_API_KEY`, `AMP_API_KEY`, Google/Slack OAuth keys, and observability settings are passed through when present. |

### Per-PR runtime values (minted by the orchestrator, injected — never stored)

| Var | Target | Notes |
|---|---|---|
| `DATABASE_URL` | web (pooled), runner (direct) | This PR's Neon branch. Web pooled, runner/Electric direct endpoint. |
| `PREVIEW_ENV` = `true` | runner | Activates the boot-time preview-identity gate (`apps/runner/src/preview-guard.ts`). |
| `NEON_BRANCH_ID` | runner | Verified against the attached endpoint via the Neon API at boot. |
| `PREVIEW_PR_NUMBER` | runner, web | The PR number. |
| `RUNNER_INTERNAL_URL` / `RUNNER_PUBLIC_URL` / `RUNNER_INTERNAL_TOKEN` | web ↔ runner | Per-PR runner URL + a freshly minted shared token. |
| `ELECTRIC_URL` / `ELECTRIC_SECRET` | web ↔ electric | Per-PR Electric URL + secret; the web proxy injects the secret server-side. |
| `DURABLE_STREAMS_URL` | web, runner | Per-PR Durable Streams service URL. |
| `INNGEST_ENV` | web | `preview-pr-<n>`, routing events and function syncs into the isolated Inngest branch environment. |
| `INNGEST_SERVE_ORIGIN` | web | `https://pr-<n>.<domain>`, ensuring Inngest calls the deterministic preview custom domain rather than a protected Vercel deployment URL. |
| `NEXT_PUBLIC_APP_URL` | web (build-time + runtime) | `https://pr-<n>.<domain>`. Used in signed OAuth state so the stable Google broker can forward back to the right preview. |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | web (build-time) | `https://pr-<n>.<domain>/auth/callback`. |
| `GOOGLE_OAUTH_CALLBACK_URL` | web | Optional pass-through from the provision environment. Set to `https://oauth.opencompany.cloud/api/google/callback` to use the stable Google OAuth broker for previews. |
| `PREVIEW_ALLOW_UNVERIFIED_ENDPOINT` | runner | Emergency escape hatch for the boot gate. Leave unset. |

The prod runner carries **none** of `PREVIEW_ENV` / `NEON_BRANCH_ID` / `PREVIEW_PR_NUMBER`;
the boot gate refuses to start if it sees a partial preview identity (symmetric guard).

Preview Render logs use the shared Better Stack Render source, normally
`opencompany-runner-preview`. Store its syslog endpoint and source token in Infisical `dev` +
`/release` as `PREVIEW_RENDER_LOG_ENDPOINT` and `PREVIEW_RENDER_LOG_TOKEN`; the token must never be
committed or printed.

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
