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

This app intentionally does not wire in OpenCompany auth, database access,
Inngest, observability, analytics, or other production app infrastructure yet.

## Develop

From the repo root:

```bash
bun --filter @opencompany/connector dev
bun --filter @opencompany/connector build
bun --filter @opencompany/connector lint
bun --filter @opencompany/connector typecheck
```

The local dev server runs on http://localhost:3002.
