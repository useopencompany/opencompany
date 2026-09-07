# Environment variables

`.env.example` is the complete local template. This document records ownership rather than
duplicating every optional provider variable.

Codex sandboxes default to `gpt-6-astra` and also offer GPT 5.6 Sol, Terra, and Luna.
`RUNNER_CODEX_MODEL` overrides the runner's fallback model; an explicit session or task selection
takes precedence. Codex availability is separate from the opencompany engine's Gateway catalog.

## Infisical paths

| Environment/path | Consumers | Contents |
| --- | --- | --- |
| `dev` `/web` | local web/API stack | browser auth/presentation values plus shared local API inputs |
| `dev` `/runner` | local runner | runner tokens, provider credentials, sandbox configuration |
| `prod` `/web` | Vercel web | browser auth, first-party origins, public URL and cron relays, email sender, and telemetry |
| `prod` `/api` | Render product API | database, auth, billing/Stripe, provider ingress, managed capabilities, Auto-routing gateway, Blob, Electric, Redis, and telemetry configuration |
| `prod` `/runner` | Render runner | production worker and broker configuration |
| `prod` `/release` | GitHub Actions | production URLs, project/service IDs, deploy tokens, DB URL |
| `prod` `/ci/turbo` | GitHub Actions | optional Turborepo remote-cache credentials |

The `/web` path is the Vercel deployment namespace; it does not imply that web owns a
product backend. Values are scoped: API database, Electric, model, billing, integration, and
provider-ingress secrets belong in `/api`; runner execution secrets belong in `/runner`. Do not
mirror an API-owned secret into `/web` unless a current thin relay actually consumes it.

The names-only production audit is recorded in [#1243](https://github.com/useopencompany/opencompany-experimental/issues/1243).
Two web exceptions remain deliberately classified as suspects rather than prune candidates:
`BLOB_READ_WRITE_TOKEN` backs the cached-client Brain upload adapter. The runner also uses its
`/runner` value for private, bounded durable Plugin data archives; it never places that token in a
Plugin process environment. `DATABASE_URL` is still reached indirectly by `AppShell`
integration-state loaders composed from shared packages. The latter violates the intended
pure-client boundary and must be removed from code before the web database value can be deleted.

## Required groups

`scripts/release-preflight.mjs` is the executable source of truth for required web, API, runner, and
release variables. When the release group is selected, it also reads the production database and
reports row counts for the retired `goat.skills` and `goat.chat_session_skills` tables plus counts
of queued/running Workflow Tasks that contain legacy `skillSnapshots` or lack per-step
`skillBundleIds` arrays. Any such active Task, or an inspection error, fails preflight. Important
contracts include:

- Web: WorkOS/AuthKit, canonical URL, shared cookie domain, first-party API origins, the narrow
  runner relay token/URL, cron relay secret, opencompany PostHog, the cached-client Blob adapter, and the
  temporary database suspect documented above; onboarding email settings remain optional. Web does
  not require Electric, model, billing, or provider-ingress credentials.
- API: direct database, the primary WorkOS browser application, the dedicated
  `WORKOS_MOBILE_CLIENT_ID` AuthKit session-bearer application, Connect OAuth issuer/audience, and
  shared cookie domain, the credentialed browser
  origin allowlist, billing/Stripe, managed capabilities and cron reconciliation, Vercel AI Gateway
  for canonical Auto routing, Blob, Electric, Redis, the cron secret for the internal email
  persistence relays, the runner token/URL for the engine-auth control calls, and
  `API_INTERNAL_TOKEN` to validate the runner→API internal wiki command endpoint. The retained
  generic PostHog compatibility sink remains optional.
- Runner: database, internal/stream tokens, `OPENCOMPANY_API_ORIGIN` and `API_INTERNAL_TOKEN` for
  the internal wiki command endpoint (agent wiki writes cross the canonical API, never the wiki
  database directly), opencompany origin, allowed origins, integration encryption, an explicitly
  enabled task-worker gate, the stable `RUNNER_SANDBOX_NAMESPACE` that scopes managed E2B cleanup,
  E2B, Blob (including Plugin data archives), model providers,
  GitHub/Google/X integration credentials, opencompany PostHog, and Redis values; capability
  controls and provider-specific tuning remain optional.
- Release: production DB URL, Vercel/Render credentials and project/service IDs (including
  `DOCS_VERCEL_PROJECT_ID`), and opencompany/API/runner URLs.

Browser clients call the non-secret `NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN` directly for commands and
authorized read models. Server Components use the server-only `OPENCOMPANY_API_ORIGIN`. Configure both
origins, the shared `WORKOS_COOKIE_DOMAIN`, and API `API_BROWSER_ORIGINS`. Chat recovery is
fix-forward as documented in [Chat operations](./chat-operations.md).

`WORKOS_MOBILE_CLIENT_ID` is public but server-owned configuration in prod `/api`. It identifies a
dedicated AuthKit application in the same WorkOS environment as `WORKOS_CLIENT_ID`, allowing users
and organizations to remain shared while the API selects a fixed mobile session-token verifier.
Future mobile builds expose the same value as `EXPO_PUBLIC_WORKOS_CLIENT_ID`; neither variable is a
client secret. Do not copy the mobile client ID into the web runtime unless web gains a real reader.

`CRON_SECRET` must have the same value in prod `/web` and `/api`: web keeps the public cron URL
while the API owns onboarding-email persistence.

The official GitHub Plugin uses a personal GitHub App. Put `GITHUB_USER_APP_SLUG`, `GITHUB_USER_APP_CLIENT_ID`,
`GITHUB_USER_APP_CLIENT_SECRET`, and `GITHUB_USER_APP_STATE_SECRET` in prod `/api`; put the client
ID and secret in prod `/runner` as well so sandbox sessions can refresh the same expiring user
credential. The public callback remains
`${OPENCOMPANY_NEXT_PUBLIC_APP_URL}/api/integrations/github-user/callback`, relayed by web to the
API. The App must request Contents, Issues, and Pull requests read/write plus Actions, Checks, and
Metadata read, with expiring user tokens and user authorization during installation enabled. Set
its Setup URL to
`${OPENCOMPANY_NEXT_PUBLIC_APP_URL}/settings/plugins/github` and enable redirect-on-update so App
updates return to opencompany.

`BLOB_READ_WRITE_TOKEN` must exist in Infisical `prod` `/runner` before enabling Plugin runtime.
The runner uses it for bounded, durable `PLUGIN_DATA` archives and never injects it into Plugin
processes.

`OPENCOMPANY_DESKTOP_AUTH_SECRET` is a web-only base64 32-byte key (same convention as
`INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`) that seals the macOS desktop app's Google sign-in handoff
token. Add it to prod `/web` before enabling desktop distribution. The release preflight requires it
for the web app so a deployment cannot expose the desktop auth flow without its sealing key.

`REDIS_URL` is optional for correctness but required by the production activation preflight. When
configured for both `apps/api` and `apps/runner`, it
enables the canonical Chat transient presentation lane; without it both services retain durable
Postgres streaming and reconnect behavior. The value is server-only and must never be copied to a
`NEXT_PUBLIC_*` variable.

The Stripe endpoint secret is `OPENCOMPANY_STRIPE_WEBHOOK_SECRET` in `prod` `/api`; it is not a web secret.
Stripe still calls the unchanged web URL, which streams the signed raw body to the API-owned
handler. Other provider URLs follow the same rule: a web relay may preserve a stable public URL,
but provider state, signing, credentials, and persistence configuration belong to the API.

The generic `NEXT_PUBLIC_POSTHOG_*` names are server-side compatibility inputs despite their
historical prefix: API billing and runner ingestion code still read them. Do not delete their only
hosted copy until those readers are retired or the values are explicitly provisioned on the two
owning runtimes.

The marketing Vercel project uses `NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN` and
`NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST` for basic page and conversion analytics in the same PostHog project
as the product. Both variables are required in production and optional for local marketing work.

The docs Vercel project has no runtime secrets. CI resolves it through `DOCS_VERCEL_PROJECT_ID` in
Infisical `prod` `/release` and rejects a project whose root is not `apps/docs` or whose ID is shared
with another Vercel surface.

## Authenticated browser profiles

Browser profiles use one Browserbase project across the canonical API and runner. Store
`OPENCOMPANY_BROWSER_PROFILES_ENABLED`, `OPENCOMPANY_BROWSER_PROFILES_KILL_SWITCH`,
`BROWSERBASE_API_KEY`, and `BROWSERBASE_PROJECT_ID` in Infisical `prod` `/api` and `/runner`.
The API creates profiles and resolves owner-checked live-view redirects; the runner drives sessions,
releases orphaned keep-alive sessions, and settles final provider timing and proxy usage. Release
preflight requires both Browserbase credentials on both services when the enabled flag is `true`.

Roll out with the enabled flag left `false`, verify the credentials and Browserbase paid plan, then
enable both services together. Setting `OPENCOMPANY_BROWSER_PROFILES_KILL_SWITCH=true` blocks new
profile use and closes an active profile before the next browser command; leave the enabled flag on
so the runner reconciler can continue releasing and settling already-created sessions.

## Experimental Revolut Business connector

Revolut Business is an internal, env-gated runner capability rather than a generally available
integration. Configure it only for a bounded read-only API evaluation:

| Variable | Required | Purpose |
| --- | ---: | --- |
| `OPENCOMPANY_REVOLUT_BUSINESS_WORKSPACE_ID` | Yes | Only workspace allowed to see the action source. |
| `OPENCOMPANY_REVOLUT_BUSINESS_API_TOKEN` | Yes | Short-lived `oa_prod_` or `oa_sand_` access token with `READ` scope only. |
| `OPENCOMPANY_REVOLUT_BUSINESS_ACCOUNT_LABEL` | No | Friendly account label shown in Chat. |
| `OPENCOMPANY_REVOLUT_BUSINESS_API_BASE_URL` | No | HTTPS API base; inferred from the token environment by default. |

The token expires after roughly 40 minutes and must never have `PAY`, `WRITE`, or
`READ_SENSITIVE_CARD_DATA` scope. The connector can list accounts and bounded expense results; it
cannot upload receipts, initiate or cancel payments, exchange currency, or return card-sensitive
data. Store production values in Infisical `prod` `/runner`. This evaluation has no public Settings
flow and is intentionally omitted from the customer integration index.

## Local generated values

`bun run setup` writes branch-specific `DATABASE_URL`, the local API listener/origin and browser
allowlist, web ports/origins, runner tokens, a workspace-specific `RUNNER_SANDBOX_NAMESPACE`, and
Electric configuration to `.env.local`. It mirrors
only the web auth/proxy/compatibility and observability subset into `apps/web/.env.local`;
API/runner provider credentials are not copied into that app-local file.
Do not put branch database URLs or generated local tokens in Infisical. `.env.override.local` may
override a developer's generated values and remains gitignored.

## Adding or removing a variable

Update the runtime reader, `.env.example`, setup/export code, Turbo env configuration, hosted
Infisical path, host sync, and release preflight together. Remove a variable only after `rg` proves
there is no runtime, script, workflow, or operational-doc consumer.
