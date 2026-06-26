# @opencompany/connector

Connector is a small MVP experiment inside the OpenCompany monorepo. It is
scaffolded here so we can move quickly while still using the repo's existing
developer workflow.

The intended future deployment target is a separate Next.js/Vercel project for
`runconnector.com`.

## What this app shares

Connector currently shares only lightweight infrastructure with the rest of the
repo:

- Bun workspaces and Turborepo task orchestration
- TypeScript, ESLint, Biome, Tailwind, and PostCSS conventions
- The first-party `@opencompany/ui` package for tokens and basic UI primitives

Most product code should stay inside `apps/connector`. Promote code to a shared
package only when another app has a real reuse case.

This app uses WorkOS AuthKit for sign-up/sign-in, but intentionally does not wire
in OpenCompany database access, Inngest, observability, analytics, or other
production app infrastructure yet.

## Auth

Connector uses the shared WorkOS AuthKit client secrets plus its own redirect URI:

```bash
WORKOS_CLIENT_ID="client_..."
WORKOS_API_KEY="sk_test_..."
WORKOS_COOKIE_PASSWORD="replace-with-at-least-32-characters"
CONNECTOR_WORKOS_REDIRECT_URI="http://localhost:3002/auth/callback"
```

`bun run setup` writes those values into `apps/connector/.env.local` so direct
Connector dev runs have the env files Next expects.

When `CONNECTOR_WORKOS_REDIRECT_URI` is unset, Connector falls back to
`NEXT_PUBLIC_WORKOS_REDIRECT_URI`, then `WORKOS_REDIRECT_URI`, then the local
`http://localhost:3002/auth/callback` default. The WorkOS dashboard callback URL
must match the value used by the app.

## Develop

From the repo root:

```bash
bun --filter @opencompany/connector dev
bun --filter @opencompany/connector build
bun --filter @opencompany/connector lint
bun --filter @opencompany/connector typecheck
```

The local dev server runs on http://localhost:3002.
