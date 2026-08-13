# Environment variables

`.env.example` is the complete local template. This document records ownership rather than
duplicating every optional provider variable.

## Infisical paths

| Environment/path | Consumers | Contents |
| --- | --- | --- |
| `dev` `/goat` | local web | shared auth, integration, billing, Electric, and product values |
| `dev` `/runner` | local runner | runner tokens, provider credentials, sandbox configuration |
| `prod` `/goat` | Vercel web | production product and webhook configuration |
| `prod` `/api` | Render canonical Chat API | database, auth, Auto-routing gateway, Blob, Electric, Redis, and telemetry configuration |
| `prod` `/runner` | Render runner | production worker and broker configuration |
| `prod` `/release` | GitHub Actions | production URLs, project/service IDs, deploy tokens, DB URL |
| `prod` `/ci/turbo` | GitHub Actions | optional Turborepo remote-cache credentials |

The `/goat` path and `GOAT_*` keys are retained compatibility contracts for the web app. Values are
scoped: a secret in `/runner` does not reach web, and a secret in `/goat` does not
reach the runner. Shared provider credentials must be present in both paths when both runtimes use
them.

## Required groups

`scripts/release-preflight.mjs` is the executable source of truth for required web, API, runner, and
release variables. Important contracts include:

- Web: database, WorkOS, canonical URL, shared cookie domain, Vercel AI Gateway, Blob, runner
  token/URL, Electric, managed capabilities, Stripe, X OAuth, cron, Goat PostHog, server and public
  first-party API origins, and canonical Chat flag values.
- API: direct database, WorkOS session/OAuth and shared cookie domain, the credentialed browser
  origin allowlist, Vercel AI Gateway for canonical Auto routing, Blob, Electric, Redis, and the
  runner token/URL for the engine-auth control calls.
- Runner: database, internal/stream tokens, Goat origin, allowed origins, integration encryption,
  E2B, model providers, GitHub/X integration credentials, Goat PostHog, and Redis values.
- Release: production DB URL, Vercel/Render credentials and project/service IDs, Goat/API/runner
  URLs.

Canonical browser clients call the non-secret `NEXT_PUBLIC_GOAT_API_ORIGIN` directly for commands
and authorized read models. RSC loaders and compatibility routes use the server-only
`GOAT_API_ORIGIN`. Configure both origins, the shared `WORKOS_COOKIE_DOMAIN`, and API
`API_BROWSER_ORIGINS`. `NEXT_PUBLIC_GOAT_HEADLESS_CHAT` controls only the Chat presentation rollout;
pass its disabled smoke gate, then enable it and redeploy web as documented in
[Headless Chat operations](./headless-chat-operations.md). Workflow, schedule, Brain, Wiki, and Skill
API clients are not controlled by that Chat flag.

`REDIS_URL` is optional for correctness but required by the production activation preflight. When
configured for both `apps/api` and `apps/runner`, it
enables the canonical Chat transient presentation lane; without it both services retain durable
Postgres streaming and reconnect behavior. The value is server-only and must never be copied to a
`NEXT_PUBLIC_*` variable.

The Stripe endpoint secret is `GOAT_STRIPE_WEBHOOK_SECRET`; there is no second product webhook.
Google OAuth uses the direct Goat callback URLs listed in `.env.example`.

## Local generated values

`bun run setup` writes branch-specific `DATABASE_URL`, local ports/origins, runner tokens, and
Electric configuration to `.env.local` and mirrors the web subset into `apps/web/.env.local`.
Do not put branch database URLs or generated local tokens in Infisical. `.env.override.local` may
override a developer's generated values and remains gitignored.

## Adding or removing a variable

Update the runtime reader, `.env.example`, setup/export code, Turbo env configuration, hosted
Infisical path, host sync, and release preflight together. Remove a variable only after `rg` proves
there is no runtime, script, workflow, or operational-doc consumer.
