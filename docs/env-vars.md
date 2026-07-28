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
| Vercel Goat | Experimental `apps/goat` project/domain | Infisical `prod` + `/goat` sync, with a separate WorkOS Application and Goat-specific app URL |
| Vercel Marketing | Production marketing site | No runtime secrets currently; release uses `MARKETING_VERCEL_PROJECT_ID` from Infisical `prod` + `/release` |
| Render Production | Production runner service | Infisical `prod` + `/runner` sync |
| Render Preview (per-PR) | Ephemeral per-PR runner / Electric / Durable Streams | Created by `scripts/preview-provision.mjs`; env minted by the orchestrator (not a static sync) |
| GitHub Actions `production` | Release workflow migrations/deploy orchestration | Infisical OIDC fetch from `prod` + `/release` |
| GitHub Actions `preview` | PR-preview provision/teardown + reaper | Infisical OIDC fetch from `dev` + `/release` (configurable) |

> **Preview environments** are a full per-PR isolated stack (Neon branch + runner + Electric + Durable Streams + Vercel web), label-gated on `preview`. See [deployment.md → PR preview environments](./deployment.md#pr-preview-environments) and the dedicated section below.

See [secret-management.md](./secret-management.md) for the Infisical setup and sync checklist.

## Local Agent MCP

These values are local developer/agent setup only. They are used by `bun run mcp:configure` to write
gitignored Claude Code and Codex MCP config for Conductor workspaces.

| Var | Required | Purpose |
|---|---:|---|
| `SIGNOZ_MCP_REGION` | No | SigNoz Cloud region used to build `https://mcp.<region>.signoz.cloud/mcp`. If unset, setup can infer the region from `GOAT_OTEL_EXPORTER_OTLP_ENDPOINT` when it uses `https://ingest.<region>.signoz.cloud:443`, then falls back to the project default `eu2`. |
| `SIGNOZ_MCP_URL` | No | Full hosted SigNoz MCP URL. Overrides `SIGNOZ_MCP_REGION` for non-standard endpoints. Do not include API keys or auth headers here. |

## Must Match Across Services

These values are cross-service contracts. Treat drift as a deploy blocker.

| Var | Must match between | Notes |
|---|---|---|
| `DATABASE_URL` / `PRODUCTION_DATABASE_URL` | Hosted Vercel, Render, GitHub Actions | Same hosted Neon database. GitHub uses `PRODUCTION_DATABASE_URL`; apps read `DATABASE_URL`. Local dev gets `DATABASE_URL` from `.env.local` Neon branch setup. |
| `RUNNER_INTERNAL_TOKEN` | Vercel, Render | Web/Inngest uses it to call runner internal endpoints. |
| `RUNNER_PUBLIC_URL` | Vercel, GitHub Actions | Browser-reachable Render URL. |
| `RUNNER_ALLOWED_ORIGINS` | Render, production web domain | Must include the exact Vercel production origin if browser-origin runner requests are enabled. |
| `DURABLE_STREAMS_URL` / `DURABLE_STREAMS_TOKEN` | Vercel, Render | Web owns the read proxy and web-authored appends; runner owns model/tool appends. |
| `BLOB_READ_WRITE_TOKEN` | Vercel, Render | Token for the private `opencompany-attachments` Blob store. Web mints client upload tokens and serves attachments; the runner downloads attachment bytes for model calls. See [Vercel Blob stores](#vercel-blob-stores). |
| `GITHUB_APP_ID` | Vercel, Render | Same GitHub App for workspace repos and runner Brain sync. |
| `GITHUB_APP_INSTALLATION_ID` | Vercel, Render | Managed workspace-state installation target used for workspace repo writes and runner Brain sync. |
| `GITHUB_APP_PRIVATE_KEY` | Vercel, Render | Same private key, with newlines preserved or escaped as `\n`. |
| `GITHUB_INTEGRATION_APP_ID` | Vercel, Render | Separate GitHub App for user-facing repository integrations. |
| `GITHUB_INTEGRATION_APP_PRIVATE_KEY` | Vercel, Render | Integration app private key, with newlines preserved or escaped as `\n`. |
| `GITHUB_INTEGRATION_APP_SLUG` | Vercel web envs | Integration GitHub App slug. |
| `GITHUB_INTEGRATION_APP_CLIENT_ID` | Vercel web envs | Integration GitHub App OAuth client id. |
| `GITHUB_INTEGRATION_APP_CLIENT_SECRET` | Vercel web envs | Integration GitHub App OAuth client secret. |
| `GITHUB_INTEGRATION_STATE_SECRET` | Vercel web envs | 32+ character secret used only to sign GitHub integration OAuth state. |
| `GITHUB_INTEGRATION_APP_WEBHOOK_SECRET` | Vercel Goat envs | Integration GitHub App webhook secret; verifies `x-hub-signature-256` on `/api/webhooks/github/events` for Goat Brain GitHub ingestion. Set the App's webhook URL to `${GOAT_NEXT_PUBLIC_APP_URL}/api/webhooks/github/events` and subscribe to Pull requests, Issues, and Issue comments. |
| `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` | Vercel web/Goat envs, Render | Base64-encoded 32-byte key used to encrypt workspace and Goat provider credentials stored in Neon. Must match everywhere credentials are written or read. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Vercel web/Goat envs, Render | Google OAuth client shared by Gmail, Google Calendar, and Google Drive integrations; credentials remain separate per provider. Goat direct redirect URIs are `${GOAT_NEXT_PUBLIC_APP_URL}/api/integrations/gmail/callback`, `.../api/integrations/google-calendar/callback`, and `.../api/integrations/google-drive/callback`; hosted previews should use `GOOGLE_OAUTH_CALLBACK_URL` instead. Enable the Calendar, Drive, Docs, and Gmail APIs. Calendar requests `calendar.events` so main-chat workers can change explicitly requested events; existing read-only Calendar connections must reconnect to grant it. Drive requests restricted `drive.readonly` access plus the sensitive `documents` scope for confirmation-gated Google Doc edits; existing Drive connections must reconnect once to enable editing. The OAuth app requires Google verification and restricted server-side access may require a security assessment. The runner also needs these values to refresh access tokens. Configure `${GOAT_NEXT_PUBLIC_APP_URL}/api/webhooks/google-drive` as the public notification address; local HTTP development automatically uses reconciliation polling only. |
| `GOOGLE_OAUTH_CALLBACK_URL` | Vercel web/Goat envs | Optional stable Google callback broker for hosted PR previews, e.g. `https://oauth.opencompany.cloud/api/google/callback`. Goat production always uses direct `${GOAT_NEXT_PUBLIC_APP_URL}` callbacks even when this shared value is present. |
| `GOOGLE_INTEGRATION_STATE_SECRET` | Vercel web/Goat envs | 32+ character secret used only to sign Google integration OAuth state. |
| `MCP_OAUTH_STATE_SECRET` | Vercel web/Goat envs | 32+ character secret used only to sign MCP OAuth setup state. Separate from the credential encryption key. Goat Linear's direct callback is `${GOAT_NEXT_PUBLIC_APP_URL}/api/integrations/linear/callback`. |
| `SLACK_MCP_CLIENT_ID` / `SLACK_MCP_CLIENT_SECRET` | Vercel, Render | Slack hosted MCP OAuth app credentials. |
| `OBSERVABILITY_RELEASE` | Vercel, Render | Manual override only. Normal hosted deploys should use Vercel/Render commit metadata and leave this unset. |

## Vercel Blob stores

Blob access mode is **per-store and immutable**, so we run two stores on the team:

| Store | Access | Used by | Token (Infisical `prod`) |
|---|---|---|---|
| `opencompany-attachments` | Private | Web (`/api/upload`, `/api/attachments/[id]`) and runner (attachment hydration) | `BLOB_READ_WRITE_TOKEN` in `/web` and `/runner` |
| `opencompany-changelog` | Public | Changelog screen recordings, uploaded at authoring time ([changelog-media.md](./changelog-media.md)) | `CHANGELOG_BLOB_READ_WRITE_TOKEN` in `/release` |

As with everything else, **Infisical is the source of truth** for the tokens the
apps read: the `/web` and `/runner` syncs deliver `BLOB_READ_WRITE_TOKEN` to
Vercel and Render.

The Vercel project additionally carries two **Vercel-managed** env vars,
`ATTACHMENTS_BLOB_READ_WRITE_TOKEN` and `CHANGELOG_BLOB_READ_WRITE_TOKEN`,
created by the store↔project connections (custom env prefixes were chosen so
they never collide with the Infisical-synced `BLOB_READ_WRITE_TOKEN`). They are
the token anchors — **do not delete the store connections or these vars**, that
revokes the tokens. No app code reads them directly.

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
| `GOAT_NEXT_PUBLIC_APP_URL` | Goat + Runner | Canonical Goat app origin. Local default is `https://localhost:3443` through Caddy; hosted value is the separate Goat domain. The runner uses it only for private bearer-protected Cloud Codex action calls. |
| `GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI` | Goat only | Goat AuthKit callback URL. Must be registered in the same WorkOS environment as the core app. |
| `GOAT_STRIPE_API_KEY` | Goat only | Dedicated restricted Stripe key for Goat customers, credit top-up Checkout, off-session auto-refill charges, and portal sessions. Store the live value in Infisical `prod` + `/goat`; use the corresponding development source for test mode. |
| `GOAT_STRIPE_CHECKOUT_ENABLED` | Goat hosted only | Production live-payment gate for credit top-up Checkout and auto-refill charges. Keep false until the business has configured its actual Stripe Tax registrations, then set true in Infisical `prod` + `/goat` and sync it to Goat Vercel. Test/local Checkout is not gated. The Goat Stripe account's webhook endpoint (the shared web `/api/stripe/webhook` route) must be subscribed to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.succeeded`, and `payment_intent.payment_failed`; its signing secret must match `STRIPE_WEBHOOK_SECRET` before enabling top-ups. |
| `GOAT_CREDITS_ENFORCEMENT_ENABLED` | Goat only | Set `true` to enforce usage credits: chat turns hard-stop with 402 on an empty balance and new ingestion pauses until the balance is positive. Usage debits and the ledger record regardless of this flag. Keep false in prod until `GOAT_STRIPE_CHECKOUT_ENABLED` is true and the starter-grant backfill (`scripts/goat-backfill-starter-credits.mjs`) has run — enforcement without purchasable top-ups locks users out. Needed by the Goat web app and the runner. |
| `CRON_SECRET` | Goat hosted only | Bearer secret protecting the hourly Goat cron routes: billing reconciliation (`/api/billing/reconcile`, charges due auto-refills then releases paused ingestion backlogs) and the onboarding email sweep (`/api/cron/onboarding-emails`). Store it in Infisical `prod` + `/goat`; sync it to the Goat Vercel project, which sends it as the cron Authorization bearer token. |
| `GOAT_PORT` | Local Goat only | Internal Next.js port for `bun run dev:goat`; defaults to `3002`. |
| `GOAT_HTTPS_PORT` | Local Goat only | Browser-facing Caddy HTTPS port for `bun run dev:goat`; defaults to `3443`. |
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
| `GOOGLE_OAUTH_CLIENT_ID` | Google only | Google OAuth client id (Gmail + Calendar + Drive integrations). |
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
| `BLOB_READ_WRITE_TOKEN` | Yes | Private `opencompany-attachments` Blob store token. Mints client upload tokens (`/api/upload`) and serves attachments (`/api/attachments/[id]`). Must match Render. |
| `LINEAR_API_KEY` | No | Enables feedback intake. |
| `LINEAR_TEAM_ID` | No | Linear team for feedback. |
| `LINEAR_FEEDBACK_PROJECT_ID` | No | Optional project routing for feedback. |
| `LINEAR_FEEDBACK_LABELS` | No | Optional comma-separated labels. |
| `GOAT_FEEDBACK_LINEAR_TEAM_ID` | Goat only | Target Goat Linear team UUID for the sidebar feedback widget. Reuses the shared `LINEAR_API_KEY`; only the team differs. Enable Triage on this team so reports land in the Triage inbox. |
| `GOAT_FEEDBACK_LINEAR_PROJECT_ID` | No | Optional project routing for Goat feedback. |
| `GOAT_FEEDBACK_LINEAR_LABELS` | No | Optional comma-separated labels added to Goat feedback issues. |
| `RESEND_API_KEY` | No | Enables transactional/lifecycle email through Resend. Missing values disable email sends. Used by the web signup welcome email and the Goat founder onboarding drip — for Goat, store it in Infisical `prod` + `/goat` (the `/web` copy does not reach Goat). |
| `RESEND_WELCOME_FROM` | No | Sender identity for the signup welcome email and the Goat onboarding drip. Defaults to `Louis from opencompany <louis@updates.opencompany.cloud>`. |
| `RESEND_REPLY_TO` | No | Reply-to address for transactional/lifecycle emails. Defaults to `louis@opencompany.cloud`. |
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
| `LATITUDE_API_KEY` | Required with `LATITUDE_PROJECT_SLUG` | Enables full-content Latitude LLM tracing for Goat chat and runner ingestion when both values are set. |
| `LATITUDE_PROJECT_SLUG` | Required with `LATITUDE_API_KEY` | Latitude project slug that receives Goat LLM spans. |
| `LATITUDE_SERVICE_NAME` | No | Service name attached to Latitude spans. Defaults to `opencompany-goat`; set `opencompany-runner-goat` for the runner. |
| `LATITUDE_TELEMETRY_DISABLED` | No | Kill switch for Latitude export when set to `true`, `1`, `on`, or `yes`. |
| `BETTER_STACK_ERRORS_DSN` | No | Server-side error capture DSN override. |
| `BETTER_STACK_PREVIEW_SOURCE_NAME` | No | Local/operator override for `bun run preview:debug-session` output. Defaults to `opencompany-runner-preview`; not a source token. |
| `NEXT_PUBLIC_OBSERVABILITY_ENABLED` | No | Browser observability toggle. |
| `NEXT_PUBLIC_OBSERVABILITY_ENV` | No | Browser observability environment. |
| `NEXT_PUBLIC_OBSERVABILITY_RELEASE` | No | Browser release tag. Production release workflow sets this from the released commit during build. |
| `NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL` | No | Browser log level. |
| `NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN` | No | Browser and fallback server error DSN. |

## Vercel Goat

`apps/goat` is an isolated experimental Next.js app. It uses a separate WorkOS AuthKit Application
in the same WorkOS environment as the core app, so users and Organizations remain shared while
redirects and API-created invitations stay on the Goat domain. It reuses the Neon database,
Electric service, and runner, but stores product state in the `goat` Postgres schema.

Set these in the separate Vercel project for Goat:

| Var | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Hosted only | Same hosted Neon database as web/runner. Goat tables live under the `goat` schema. |
| `WORKOS_CLIENT_ID` | Yes | Goat WorkOS Application client id. Must differ from the core app. |
| `WORKOS_API_KEY` | Yes | Goat WorkOS Application API key. Must differ from the core app so API-created invitations preserve Goat application context. |
| `WORKOS_COOKIE_PASSWORD` | Yes | AuthKit cookie encryption secret, 32+ characters. Use the same value only when the cookie domain setup intentionally allows it. |
| `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` | Google or Slack | Same base64-encoded 32-byte key used by web and runner. Required when Goat Gmail/Calendar/Drive or either Slack connection is enabled. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google only | Google OAuth app used by Goat Gmail, Google Calendar, and Drive connect flows. Must match the runner values so refresh works. Drive also requires the Drive and Docs APIs plus restricted-scope verification; accounts connected before Google Doc editing was added must reconnect once to grant it. |
| `GOOGLE_OAUTH_CALLBACK_URL` | Google only | Optional stable Google callback broker URL for hosted previews. Leave unset for direct Goat-domain callbacks. |
| `GOOGLE_INTEGRATION_STATE_SECRET` | Google only | Dedicated secret used to sign Goat Google OAuth setup state. |
| `VERCEL_AI_GATEWAY_API_KEY` | Yes | Model calls for the default Goat chat agent. Same key the runner uses for Goat tasks. |
| `BLOB_READ_WRITE_TOKEN` | Yes | Private chat attachments and authenticated browser screenshots. Use the Goat project's Blob store token. |
| `GOAT_NEXT_PUBLIC_APP_URL` | Yes | Canonical Goat domain origin, for example `https://goat.example.com`. Production URL generation fails closed when this is missing instead of falling back to the legacy web origin. |
| `GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI` | Yes | Goat callback URL, for example `https://goat.example.com/auth/callback`. |
| `GOAT_AUTHKIT_DOMAIN` | Goat auth | AuthKit issuer origin used to verify Goat MCP connector and Goat Quick bearer tokens, for example `https://example.authkit.app`. MCP setup also requires Client ID Metadata Documents and Dynamic Client Registration in WorkOS. |
| `GOAT_MACOS_OAUTH_AUDIENCE` | Goat Quick | Resource audience (`aud`) WorkOS places in access tokens accepted by Goat's `/api/chat`. This is distinct from the OAuth client ID and is not a secret. |
| `GOAT_MACOS_OAUTH_CLIENT_ID` | Goat Quick | Client ID of the first-party public WorkOS OAuth application used by Goat Quick. This is a public identifier used by the native client and is intentionally distinct from the access token audience. |
| `GOAT_SLACK_CLIENT_ID` / `GOAT_SLACK_CLIENT_SECRET` | Slack only | Goat Slack ingestion app OAuth credentials (user-token app, `user_scope` only — no bot token). Distinct from `SLACK_MCP_*` and `SLACK_SUPPORT_*`. Redirect URL: `${GOAT_NEXT_PUBLIC_APP_URL}/api/integrations/slack/callback`. |
| `GOAT_SLACK_SIGNING_SECRET` | Slack only | Slack app signing secret used to verify Events API deliveries at `/api/webhooks/slack/events`. |
| `GOAT_SLACK_STATE_SECRET` | Slack only | Dedicated secret used to sign Goat Slack OAuth setup state. Generate with `openssl rand -base64 32`. |
| `GOAT_SLACK_BOT_CLIENT_ID` / `GOAT_SLACK_BOT_CLIENT_SECRET` | Slack bot only | Goat Slack answer-bot app OAuth credentials (bot-token app, `scope=` — separate Slack app from the ingestion one). Redirect URL: `${GOAT_NEXT_PUBLIC_APP_URL}/api/integrations/slack-bot/callback`. The Slack app manifest must grant the bot scopes in `GOAT_SLACK_BOT_SCOPES` (`app_mentions:read`, `chat:write`, `channels:read`, `groups:read`, `channels:history`, `groups:history`, `im:history`, `reactions:write`, `users:read`, `users:read.email`), subscribe to bot events `app_mention`, `message.channels`, `message.groups`, `message.im`, and enable App Home → Messages Tab ("Allow users to send … messages from the messages tab") so members can DM the bot. Workspaces installed before a scope was added keep working for mentions; the settings page shows a reconnect banner until they re-OAuth. |
| `GOAT_SLACK_BOT_SIGNING_SECRET` | Slack bot only | Slack bot app signing secret used to verify Events API deliveries at `/api/webhooks/slack-bot/events`. |
| `GOAT_SLACK_BOT_STATE_SECRET` | Slack bot only | Dedicated secret used to sign Goat Slack bot install state. Generate with `openssl rand -base64 32`. |
| `RUNNER_INTERNAL_URL` / `RUNNER_PUBLIC_URL` | Yes | Server-to-server runner URL. `RUNNER_INTERNAL_URL` wins when set. |
| `RUNNER_INTERNAL_TOKEN` | Yes | Bearer token for the runner wake route. Must match Render. |
| `ELECTRIC_URL` | Yes | Electric shape service base URL. The Goat proxy exposes only `goat.tasks` scoped to the signed-in WorkOS user. |
| `ELECTRIC_SOURCE_ID` / `ELECTRIC_SOURCE_SECRET` | Electric Cloud only | Electric Cloud source auth. |
| `ELECTRIC_SECRET` / `ELECTRIC_TOKEN` | Self-hosted Electric only | Optional self-hosted Electric auth. |
| `REDIS_URL` (or `KV_URL`) | No | Enables resumable Goat chat streams (`resumable-stream`): refreshes reattach to in-flight turns, disconnects no longer cancel generation, and the stop button cancels via `/api/chat/[sessionId]/stop`. Without it, chat still works; a mid-stream disconnect persists the partial response instead. |
| `GOAT_CHAT_ACTIONS_KILL_SWITCH` | No | Set to `true` to globally disable Goat chat actions (the `list_actions`/`use_action` tools over Attio, Slack, Gmail, Google Calendar, Google Drive, and Linear) for everyone, without a deploy rollback. Chat actions are otherwise on by default for connected integrations. |
| `GOAT_CHAT_SANDBOX_IMAGE` | Recommended with browser sandbox | Complete Vercel Container Registry image reference built from `apps/goat/sandbox-image`. Without it, the first browser use provisions `agent-browser` and Chromium in a stock Node 24 sandbox. See `docs/goat-chat-sandbox.md`. |
| `MONID_API_KEY` | Yes | Server-only API key for Goat’s curated managed social and lead capabilities. Store it in Infisical `prod` + `/goat`; it must never reach the browser or runner. |
| `GOAT_MANAGED_CAPABILITIES_KILL_SWITCH` | No | Set to `true` to remove all managed social and lead capabilities from new chat turns without disabling connected-integration actions. Already-started runs continue through billing reconciliation. |
| `GOAT_DISABLED_MANAGED_CAPABILITY_ACTIONS` | No | Comma-separated exact managed action ids (for example `x.search_posts,linkedin.list_comments`) to remove individual reviewed endpoints from new chat turns. Execution also fails closed if a stale catalog attempts a disabled action. |
| `SUPADATA_API_KEY` | No | Used by the runner's hosted YouTube tools (Supadata-backed). |
| `GOAT_OBSERVABILITY_ENABLED` | No | Enables Goat OpenTelemetry traces and metrics when `true`, `1`, `on`, or `yes`. Missing or false disables the package. |
| `GOAT_OTEL_EXPORTER_OTLP_ENDPOINT` | Required with Goat OTel | OTLP HTTP base endpoint for SigNoz, for example `https://ingest.<region>.signoz.cloud:443` or `http://signoz:4318`. |
| `GOAT_OTEL_EXPORTER_OTLP_HEADERS` | SigNoz Cloud only | Comma-separated OTLP headers, usually `signoz-ingestion-key=<key>`. Leave empty for most self-hosted SigNoz setups. |
| `LATITUDE_API_KEY` / `LATITUDE_PROJECT_SLUG` | No; both required to enable | Enables full-content Latitude tracing for Goat chat and Slack bot model calls. Store both in Infisical `prod` + `/goat` before enabling. |
| `LATITUDE_SERVICE_NAME` | No | Latitude service name. Defaults to `opencompany-goat`. |
| `LATITUDE_TELEMETRY_DISABLED` | No | Emergency kill switch for Latitude export. |

Goat main chat uses `EXA_API_KEY` for optional lightweight public-web search. The runner also needs
`EXA_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `E2B_API_KEY`,
`INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`, and Google OAuth client credentials for Goat tasks that use
Gmail or Google Calendar. Goat does not introduce a separate chat model key.

Goat Slack ingestion app setup checklist (api.slack.com/apps → From scratch):

1. OAuth & Permissions → **User Token Scopes** (no bot scopes): `channels:history`,
   `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`,
   `mpim:read`, `users:read`, `team:read`, plus `search:read` for chat-capability keyword search
   (connections created before the search scope was added keep working without search until the
   user reconnects).
   Do not opt into token rotation.
2. Redirect URL: `${GOAT_NEXT_PUBLIC_APP_URL}/api/integrations/slack/callback`.
3. Event Subscriptions → Request URL `${GOAT_NEXT_PUBLIC_APP_URL}/api/webhooks/slack/events`,
   then under **Subscribe to events on behalf of users** add `message.channels`,
   `message.groups`, `message.im`, `message.mpim`. Slack sends `url_verification` when the URL
   is saved, so the deployment must be live first.
4. Copy Client ID/Secret/Signing Secret into `GOAT_SLACK_*`; the state secret is generated, not
   from Slack. The runner flushes buffered messages and needs no Slack env of its own — it reads
   the per-user token via `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`.
5. Local dev: the events URL must be public — use a second "dev" Slack app whose Request URL
   points at a tunnel (for example `cloudflared tunnel --url http://localhost:3443`) in front of
   the local Goat app.

Goat Slack answer-bot app setup checklist (api.slack.com/apps → From scratch, a **separate app**
from the ingestion one — this one has a bot user, named e.g. `OpenCompany` / `@opencompany`):

1. OAuth & Permissions → **Bot Token Scopes** (no user scopes): `app_mentions:read`, `chat:write`,
   `channels:read`, `groups:read`, `channels:history`, `groups:history`. Do not opt into token
   rotation.
2. Redirect URL: `${GOAT_NEXT_PUBLIC_APP_URL}/api/integrations/slack-bot/callback`.
3. Event Subscriptions → Request URL `${GOAT_NEXT_PUBLIC_APP_URL}/api/webhooks/slack-bot/events`,
   then under **Subscribe to bot events** add `app_mention`, `app_uninstalled`, `tokens_revoked`.
4. Add Client ID/Secret/Signing Secret to Infisical under `prod` + `/goat` (and `dev` + `/goat`
   for shared development), then sync them into the Goat Vercel environments. The
   state secret is generated, not sourced from Slack; store and sync it through Infisical too.
   Workspace admins install the bot from Settings → Workspace → Slack bot, then enable it per brain
   under Brain settings → Destinations and invite it to the chosen channels.
5. Answers run inline in the goat web app (no runner env needed) and use
   `VERCEL_AI_GATEWAY_API_KEY` plus `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` to read the stored
   bot token.

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

Channel naming: each customer channel is `<customer-slug>-x-opencompany-<id8>` — the customer
name leads so the channel reads cleanly in Slack's sidebar, and the short per-workspace suffix
at the end keeps two same-named customers from colliding. Ownership is also stamped in the
channel purpose (`opencompany-support:<workspaceId>`) and checked before adopting on a retry,
so a channel is never hijacked across workspaces.

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
| `GOAT_NEXT_PUBLIC_APP_URL` | Yes for Cloud Codex actions | Canonical Goat origin. The runner calls its private integration-action gateway with `RUNNER_INTERNAL_TOKEN`; neither value enters the Codex sandbox. |
| `RUNNER_STREAM_TOKEN_SECRET` | Yes | Runner signing secret used for hosted-tool polling job ids. |
| `RUNNER_ALLOWED_ORIGINS` | Yes | Comma-separated browser origins allowed for runner requests. |
| `DURABLE_STREAMS_URL` | Yes | Durable Streams base URL for model/tool transcript appends. Must match Vercel. |
| `DURABLE_STREAMS_TOKEN` | Yes | Bearer token for the Durable Streams service. Must match Vercel. |
| `BLOB_READ_WRITE_TOKEN` | Yes | Private `opencompany-attachments` Blob store token. Downloads attachment bytes (images/PDFs) to inline into model calls. Must match Vercel. |
| `E2B_API_KEY` | Yes | Creates/connects E2B sandboxes. |
| `VERCEL_AI_GATEWAY_API_KEY` | Yes | Model calls through Vercel AI Gateway. |
| `EXA_API_KEY` | Goat/Exa only | Required for Goat main chat web search, Goat tasks, and agents that enable Exa. |
| `RUNNER_GOAT_BROWSER_ENABLED` | Goat Browser only | Enables Goat task browser tools. Defaults to `false`. When enabled in production, the runner defaults to `AGENT_BROWSER_PROVIDER=browserless`. |
| `AGENT_BROWSER_PROVIDER` | Goat Browser only | Optional `agent-browser` provider override. Leave unset for local Chrome; use `browserless` in production unless intentionally testing another provider. |
| `BROWSERLESS_API_KEY` | Goat Browser only | Required when browser tools run with `AGENT_BROWSER_PROVIDER=browserless`. |
| `BROWSERLESS_API_URL` / `BROWSERLESS_TTL` / `BROWSERLESS_STEALTH` | Goat Browser only | Optional Browserless provider settings passed through to `agent-browser`. |
| `APIFY_API_TOKEN` | No | Required only for agents that enable Apify-backed X, Instagram, or TikTok profile/feed/comment/search/discussion tools. |
| `X_API_BEARER_TOKEN` | No | Deprecated/unused by the X hosted tool; retained only for older env files. |
| `SUPADATA_API_KEY` | No | Required only for agents that enable Supadata-backed YouTube tools or TikTok/Instagram direct-media transcript/metadata tools. |
| `OPENCOMPANY_E2B_TEMPLATE` | No | Optional custom E2B template. |
| `AMP_API_KEY` | AMP only | Platform AMP credential used by the runner when agents enable the AMP coding tool. |
| `OPENCOMPANY_AMP_E2B_TEMPLATE` | No | Optional AMP-specific E2B template; defaults to `amp`. |
| `OPENCOMPANY_CODEX_E2B_TEMPLATE` | No | Optional Codex-specific E2B template; defaults to `codex`. Build `apps/runner/e2b/codex` as `opencompany-codex-toolbox` and set this in runner envs to roll onto the custom toolbox image. |
| `RUNNER_LLM_BROKER_PUBLIC_URL` | No | Public base URL of the runner for E2B sandbox callbacks: the LLM broker (`/broker/*`) and Goat Google tools (`/goat/tools/*`). Defaults to Render's `RENDER_EXTERNAL_URL`; unset local dev disables callback-only features unless you expose the local runner port (3040) through a public tunnel. Distinct from the web-side `RUNNER_PUBLIC_URL`, which points at localhost in local dev. |
| `RUNNER_LLM_BROKER_ENABLED` | No | Kill switch for the LLM broker, defaults to `true`. Set `false` to revert sandboxed CLIs to direct key injection without a deploy. |
| `RUNNER_GOAT_TASK_WORKER_ENABLED` | Goat only | Enables the experimental Goat task worker and runner-hosted Goat tools. Defaults to `false`; set `true` only on a runner intended to execute Goat tasks. `bun run dev:goat` injects it locally. |
| `RUNNER_CODEX_API_KEY_FALLBACK_ENABLED` | No | Explicit kill switch for the legacy Codex API-key path when no workspace Codex account is connected. Defaults to disabled in production and enabled outside production. Set `false` locally to force device-auth testing. |
| `OPENAI_CODEX_API_KEY` | Codex fallback only | Platform OpenAI key used by the legacy Codex fallback path. Brokered fallback runs use it server-side as the LLM broker's upstream credential for the `openai` provider (`codex_coder`); local-dev fallback maps it to `CODEX_API_KEY` for the Codex CLI. Production/company runs should use the workspace Codex account connected in company settings instead. |
| `RUNNER_CODEX_MODEL` | No | Fallback Codex CLI model for `codex_coder`, defaults to `gpt-5.5`. Active Codex sessions normally use their persisted session model. |
| `RUNNER_CODEX_TIMEOUT_MS` | No | Wall-clock ceiling for a single Codex engine turn or `codex_coder` delegation, defaults to `3600000` (1 hour). Timeouts surface partial output and skip PR creation. |
| `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` | Yes | Decrypts workspace MCP, Goat MCP, and Google (Gmail/Calendar/Drive) credentials. Validated at runner boot — the runner fails to start if it is missing or malformed. Must match Vercel/Goat. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google only | Used by the runner to refresh Gmail/Calendar/Drive access tokens against Google's token endpoint. Must match Vercel. |
| `SLACK_MCP_CLIENT_ID` | MCP only | Slack hosted MCP OAuth client id. Must match Vercel. |
| `SLACK_MCP_CLIENT_SECRET` | MCP only | Slack hosted MCP OAuth client secret. Must match Vercel. |
| `RUNNER_E2B_IDLE_TIMEOUT_MS` | No | Sandbox idle timeout, defaults to `30000`. |
| `RUNNER_GOAT_CODEX_CHAT_IDLE_TIMEOUT_MS` | Goat Codex chat only | Idle timeout for persistent Goat Codex chat sandboxes, defaults to `300000` (5 minutes). Sandboxes pause on idle and auto-resume on the next message. |
| `RUNNER_GOAT_TASK_WORKER_ENABLED` | Goat only | Enables the experimental Goat task worker and `/goat/tools/*` runner callbacks. Defaults to `false` so normal runner deployments do not poll Goat tables or expose Goat tool execution. |
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
| `GOAT_OBSERVABILITY_ENABLED` | No | Enables Goat task OpenTelemetry traces and metrics from the runner when `true`, `1`, `on`, or `yes`. |
| `GOAT_OTEL_EXPORTER_OTLP_ENDPOINT` | Required with Goat OTel | OTLP HTTP base endpoint for SigNoz. The package appends `/v1/traces` and `/v1/metrics`. |
| `GOAT_OTEL_EXPORTER_OTLP_HEADERS` | SigNoz Cloud only | Comma-separated OTLP headers, usually `signoz-ingestion-key=<key>`. |
| `BRAINTRUST_ENABLED` | No | Enables Braintrust runner tracing when set to `true`, `1`, `on`, or `yes`. |
| `BRAINTRUST_API_KEY` | Required with `BRAINTRUST_ENABLED` | Braintrust API key for runner traces. |
| `BRAINTRUST_PROJECT_ID` | No | Braintrust project UUID for runner traces. Takes precedence over `BRAINTRUST_PROJECT_NAME`. |
| `BRAINTRUST_PROJECT_NAME` | No | Braintrust project name for runner traces. Defaults to `OpenCompany Runner`. |
| `LATITUDE_API_KEY` / `LATITUDE_PROJECT_SLUG` | No; both required to enable | Enables full-content Latitude tracing for Goat brain ingestion. Store both in Infisical `prod` + `/runner` before enabling. |
| `LATITUDE_SERVICE_NAME` | No | Latitude service name. Set to `opencompany-runner-goat` for runner spans. |
| `LATITUDE_TELEMETRY_DISABLED` | No | Emergency kill switch for Latitude export. |

Render also injects `PORT` and `RENDER_GIT_COMMIT`; do not set them manually unless debugging.

## GitHub Actions CI Cache

PR quality jobs use Vercel Remote Cache when these repository-level GitHub Actions secrets are set:

| Name | Storage | Purpose |
|---|---|---|
| `TURBO_TEAM` | Infisical `prod` + `/ci/turbo` | Vercel team slug that owns the shared Turborepo cache. |
| `TURBO_TOKEN` | Infisical `prod` + `/ci/turbo` | Vercel access token allowed to read and write the team's remote cache. |

Infisical is the source of truth; publish both values to GitHub Actions as repository secrets after
creation or rotation. Do not fetch them through the Preview OIDC identity in this workflow: PR code
runs inside these jobs, while repository secrets are automatically withheld from fork pull requests.
The workflow remains functional without them and falls back to local execution. Developers may set
the same optional values locally to share cached tasks with CI; never commit a real token.

## GitHub Actions Production

Use a protected GitHub environment named `production`. Store release secrets in Infisical `prod` +
`/release`; the workflow fetches them with OIDC at runtime.

Infisical `prod` + `/release` secrets:

| Name | Purpose |
|---|---|
| `PRODUCTION_DATABASE_URL` | Production Neon URL used by release migrations. |
| `VERCEL_TOKEN` | Vercel CLI deploy token. |
| `VERCEL_ORG_ID` | Vercel team/org id. |
| `VERCEL_PROJECT_ID` | Vercel web project id. |
| `GOAT_VERCEL_PROJECT_ID` | Vercel Goat project id. |
| `MARKETING_VERCEL_PROJECT_ID` | Vercel marketing project id. |
| `RENDER_SERVICE_ID` | Render service id for `opencompany-runner`. |
| `RENDER_API_KEY` | Render API key used to trigger and poll runner deploys. |
| `PRODUCTION_WEB_URL` | Canonical production web URL for smoke checks. |
| `PRODUCTION_GOAT_URL` | Canonical production Goat URL for smoke checks. |
| `RUNNER_PUBLIC_URL` | Canonical production runner URL for smoke checks. |
| `CHANGELOG_BLOB_READ_WRITE_TOKEN` | Public `opencompany-changelog` Blob store token. Authoring-time credential for uploading changelog screen recordings (see [changelog-media.md](./changelog-media.md)); not read by CI or any runtime. |

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
| `EXPECTED_RELEASE` | No | Backwards-compatible expected SHA for every enabled smoke-check surface that does not set a surface-specific override. |
| `EXPECTED_WEB_RELEASE` | No | Expected SHA for the web health check. Set to an empty value to require health without a release match. |
| `EXPECTED_GOAT_RELEASE` | No | Expected SHA for the Goat health check. Set to an empty value to require health without a release match. |
| `EXPECTED_RUNNER_RELEASE` | No | Expected SHA for the runner health check. Set to an empty value to require health without a release match. |
| `RENDER_DEPLOY_TIMEOUT_MS` | No | Maximum time to wait for the Render deploy API before smoke checks. Defaults to `900000`. |
| `RENDER_DEPLOY_POLL_MS` | No | Delay between Render deploy status polls. Defaults to `10000`. |
| `RENDER_DEPLOY_STALE_MS` | No | Age after which an in-flight Render deploy is considered hung or superseded; the release script cancels such deploys before triggering (and cancels its own deploy on wait timeout) so they cannot block the queue. Defaults to `600000`. |
| `VERCEL_READY_POLL_MS` | No | Delay between Vercel deployment readiness polls. Defaults to `2000`. |
| `SMOKE_WEB` | No | Set to `false`, `0`, or `no` to skip web health checks. Defaults to enabled. |
| `SMOKE_GOAT` | No | Set to `true`, `1`, or `yes` to include the Goat health check. Defaults to disabled for local script runs; the production workflow enables it. |
| `SMOKE_RUNNER` | No | Set to `false`, `0`, or `no` to skip runner health checks. Defaults to enabled. |
| `SMOKE_ATTEMPTS` | No | Default health retry count. Defaults to `30`. |
| `SMOKE_WEB_ATTEMPTS` | No | Web health retry count. Falls back to `SMOKE_ATTEMPTS`; workflow uses `12`. |
| `SMOKE_GOAT_ATTEMPTS` | No | Goat health retry count. Falls back to `SMOKE_ATTEMPTS`; workflow uses `12`. |
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
| `E2B_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `OPENAI_CODEX_API_KEY`, `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` | runner | Required at runner boot. `OPENAI_CODEX_API_KEY` is the broker upstream for `codex_coder`; the encryption key must match web so preview runners can read seeded encrypted integration credentials. |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | runner | Enables runner Brain sync. |
| `GITHUB_INTEGRATION_APP_ID`, `GITHUB_INTEGRATION_APP_PRIVATE_KEY` | runner | Enables connected-repository GitHub operations. |
| Optional runner tool/provider keys | runner | `EXA_API_KEY`, `APIFY_API_TOKEN`, `SUPADATA_API_KEY`, `AMP_API_KEY`, Google/Slack OAuth keys, and observability settings are passed through when present. `X_API_BEARER_TOKEN` is deprecated and unused by the X hosted tool. |

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

Setup also writes `apps/goat/.env.local` with the Goat-local aliases and the DB/Auth/runner/Electric
values the experimental app needs. Root `.env.local` remains the source of truth; rerun
`bun run setup` or `bun run env:pull` after changing shared local secrets so the Goat app-local file
is refreshed.

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
| `OPENCOMPANY_NGROK_URL` | Optional stable ngrok origin for local integration callback testing. In Goat dev mode, the same origin is routed through a local proxy to both the Goat app and runner callbacks. |
| `NGROK_AUTHTOKEN` | Optional ngrok auth token for local dev. Prefer the local ngrok config unless sharing through Infisical. |
| `OPENCOMPANY_NGROK_REQUIRED` | Set to `1` to fail `bun run dev` when ngrok cannot start. Fixed ngrok URLs are treated as required. |
| `OPENCOMPANY_NGROK_DISABLED` | Set to `1` to skip automatic ngrok startup in `bun run dev`. |
| `OPENCOMPANY_GOAT_HTTPS_DISABLED` | Set to `1` to skip automatic Caddy HTTPS for `bun run dev:goat`; Goat falls back to HTTP on `GOAT_PORT`. |
| `GOAT_LOCAL_PROJECTS_DIR` | Optional managed clone folder for Local Codex. Defaults to `~/.opencompany/goat/projects`; `bun run dev:goat` creates it when the local bridge launcher starts. |
| `PLAYWRIGHT_PORT` | Optional Playwright web server port. |

For local integration testing, `bun run dev` starts ngrok automatically when the local ngrok CLI is
authenticated. It injects `NEXT_PUBLIC_APP_URL` and `RUNNER_ALLOWED_ORIGINS` into the dev process
without changing `.env.local`. `bun run dev:goat` additionally starts Caddy when available and
injects `https://localhost:3443` as the local Goat app URL so Electric shape requests use HTTP/2.
It also exposes a local proxy through ngrok and injects `RUNNER_LLM_BROKER_PUBLIC_URL` so E2B Goat
tasks can call runner `/goat/tools/*` and `/broker/*` routes. Local web WorkOS redirects stay on
`http://localhost:3000/auth/callback`; local Goat redirects use
`https://localhost:3443/auth/callback`.

## Checks

Check local web and runner env coverage:

```bash
bun run release:preflight
```

Check only web, Goat, or runner env coverage:

```bash
bun run release:preflight -- --web
bun run release:preflight -- --goat
bun run release:preflight -- --runner
```

Check only release automation env:

```bash
bun run infisical:release:preflight
```

Run deployed health checks:

```bash
PRODUCTION_WEB_URL=https://app.example.com \
PRODUCTION_GOAT_URL=https://goat.example.com \
RUNNER_PUBLIC_URL=https://opencompany-runner.onrender.com \
SMOKE_GOAT=true \
bun run release:smoke
```
