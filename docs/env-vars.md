# Environment variables

`.env.example` is the complete local template. This document records ownership rather than
duplicating every optional provider variable.

## Infisical paths

| Environment/path | Consumers | Contents |
| --- | --- | --- |
| `dev` `/goat` | local web/API stack | browser auth/presentation values plus shared local API inputs |
| `dev` `/runner` | local runner | runner tokens, provider credentials, sandbox configuration |
| `prod` `/goat` | Vercel web | browser auth, first-party origins, public URL relays, email sender, and telemetry |
| `prod` `/api` | Render canonical API | database, auth, billing/Stripe, managed capabilities, Auto-routing gateway, Blob, Electric, Redis, and telemetry configuration |
| `prod` `/runner` | Render runner | production worker and broker configuration |
| `prod` `/release` | GitHub Actions | production URLs, project/service IDs, deploy tokens, DB URL |
| `prod` `/ci/turbo` | GitHub Actions | optional Turborepo remote-cache credentials |

The `/goat` path remains the Vercel deployment namespace; it no longer implies that web owns a
product backend. Values are scoped: API database, Electric, model, billing, integration, and
provider-ingress secrets belong in `/api`; runner execution secrets belong in `/runner`. Do not
mirror an API-owned secret into `/goat` unless a current thin relay actually consumes it.

## Required groups

`scripts/release-preflight.mjs` is the executable source of truth for required web, API, runner, and
release variables. Important contracts include:

- Web: WorkOS/AuthKit, canonical URL, shared cookie domain, first-party API origins, the narrow
  runner relay token/URL, cron relay secret, email sender, and Goat PostHog configuration. Web does
  not require database, Electric, model, Blob, billing, or provider-ingress credentials.
- API: direct database, WorkOS session/OAuth and shared cookie domain, the credentialed browser
  origin allowlist, billing/Stripe, managed capabilities and cron reconciliation, Vercel AI Gateway
  for canonical Auto routing, Blob, Electric, Redis, the cron secret for the internal email
  persistence relays, and the runner token/URL for the engine-auth control calls.
- Runner: database, internal/stream tokens, Goat origin, allowed origins, integration encryption,
  E2B, model providers, GitHub/X integration credentials, Goat PostHog, and Redis values.
- Release: production DB URL, Vercel/Render credentials and project/service IDs, Goat/API/runner
  URLs.

Canonical browser clients call the non-secret `NEXT_PUBLIC_GOAT_API_ORIGIN` directly for commands
and authorized read models. RSC loaders use the server-only `GOAT_API_ORIGIN`. Configure both
origins, the shared `WORKOS_COOKIE_DOMAIN`, and API `API_BROWSER_ORIGINS`. Chat is fully cut over and
operates fix-forward as documented in [Headless Chat operations](./headless-chat-operations.md).

`CRON_SECRET` must have the same value in prod `/goat` and `/api`: web keeps the public cron URL
while the API owns onboarding-email persistence.

`REDIS_URL` is optional for correctness but required by the production activation preflight. When
configured for both `apps/api` and `apps/runner`, it
enables the canonical Chat transient presentation lane; without it both services retain durable
Postgres streaming and reconnect behavior. The value is server-only and must never be copied to a
`NEXT_PUBLIC_*` variable.

The Stripe endpoint secret is `GOAT_STRIPE_WEBHOOK_SECRET` in `prod` `/api`; it is not a web secret.
Stripe still calls the unchanged web URL, which streams the signed raw body to the API-owned
handler. Other historical provider URLs follow the same rule: a web relay may preserve the public
URL, but provider state, signing, credentials, and persistence configuration belong to the API.

## Local generated values

`bun run setup` writes branch-specific `DATABASE_URL`, local ports/origins, runner tokens, and
Electric configuration to `.env.local` and mirrors the web subset into `apps/web/.env.local`.
Do not put branch database URLs or generated local tokens in Infisical. `.env.override.local` may
override a developer's generated values and remains gitignored.

## Adding or removing a variable

Update the runtime reader, `.env.example`, setup/export code, Turbo env configuration, hosted
Infisical path, host sync, and release preflight together. Remove a variable only after `rg` proves
there is no runtime, script, workflow, or operational-doc consumer.
