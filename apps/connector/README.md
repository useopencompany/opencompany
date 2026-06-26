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

This app uses WorkOS AuthKit for sign-up/sign-in and the shared Drizzle/Neon
database client. Connector-owned tables live in the dedicated Postgres
`connector` schema and TypeScript exports are prefixed with `connector*` to keep
the experiment separate from the main OpenCompany product model.

## Auth

Connector uses the shared WorkOS AuthKit client secrets plus its own redirect URI:

```bash
WORKOS_CLIENT_ID="client_..."
WORKOS_API_KEY="sk_test_..."
WORKOS_COOKIE_PASSWORD="replace-with-at-least-32-characters"
CONNECTOR_WORKOS_REDIRECT_URI="http://localhost:3002/auth/callback"
CONNECTOR_APP_URL="http://localhost:3002"
```

`bun run setup` writes those values into `apps/connector/.env.local` so direct
Connector dev runs have the env files Next expects.

When `CONNECTOR_WORKOS_REDIRECT_URI` is unset, Connector falls back to
`NEXT_PUBLIC_WORKOS_REDIRECT_URI`, then `WORKOS_REDIRECT_URI`, then the local
`http://localhost:3002/auth/callback` default. The WorkOS dashboard callback URL
must match the value used by the app.

## Linear MCP OAuth

The MVP connects one upstream remote MCP server: Linear at
`https://mcp.linear.app/mcp`. Connector uses dynamic MCP OAuth client
registration, signs callback state with a Connector-only secret, and stores the
encrypted OAuth payload in `connector.mcp_credentials`.

Required local env. `bun run setup` writes local generated values into
`apps/connector/.env.local`; generate manually only when configuring a hosted
deployment:

```bash
CONNECTOR_MCP_OAUTH_STATE_SECRET="replace-with-a-long-random-secret"
CONNECTOR_CREDENTIAL_ENCRYPTION_KEY="replace-with-base64-encoded-32-byte-key"
```

Generate the credential key with:

```bash
openssl rand -base64 32
```

The permission labels in setup are Connector policy settings. They do not change
Linear OAuth scopes in this iteration.

## Deploy

Connector deploys as its own Vercel project from the monorepo:

- Root directory: `apps/connector`
- Install command: `if [ -f ../../bun.lock ]; then cd ../..; fi; bun install --frozen-lockfile`
- Build command: `if [ -f ../../turbo.json ]; then cd ../..; fi; bun run build --filter=@opencompany/connector`
- Production domain: `runconnector.com`
- Automatic Vercel Git deploys: disabled

Production env comes from Infisical `prod` + `/connector` and is synced to the
Connector Vercel project. The production release workflow deploys Connector
after production migrations and alongside the existing web/runner release.

Required production env:

```bash
DATABASE_URL="postgresql://..."
WORKOS_CLIENT_ID="client_..."
WORKOS_API_KEY="sk_..."
WORKOS_COOKIE_PASSWORD="replace-with-at-least-32-characters"
NEXT_PUBLIC_WORKOS_REDIRECT_URI="https://runconnector.com/auth/callback"
CONNECTOR_WORKOS_REDIRECT_URI="https://runconnector.com/auth/callback"
CONNECTOR_APP_URL="https://runconnector.com"
CONNECTOR_MCP_OAUTH_STATE_SECRET="replace-with-a-long-random-secret"
CONNECTOR_CREDENTIAL_ENCRYPTION_KEY="replace-with-base64-encoded-32-byte-key"
```

## Develop

From the repo root:

```bash
bun --filter @opencompany/connector dev
bun --filter @opencompany/connector build
bun --filter @opencompany/connector lint
bun --filter @opencompany/connector typecheck
bun --filter @opencompany/connector test
```

The local dev server runs on http://localhost:3002.
