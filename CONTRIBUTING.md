# Contributing

Keep pull requests focused, reviewable, and fully verified.

## Local checks

Run the CI-equivalent gates before opening a pull request:

```bash
bun run format:check
bun run boundary:check
bun run lint
bun run typecheck
bun run build
bun run test
bun run db:migrations:check
bun run secrets:check
```

TruffleHog must be installed for the local secret scan. CI runs the same scan on pull requests.
`boundary:check` enforces the permanent rule that production `apps/web` code cannot import the
database, Drizzle, or retired worker-control transports; `lint` runs the same check.
For focused checks, use Turborepo filters such as `bun run test --filter @opencompany/web` and
`bun run test --filter @opencompany/runner`.

UI changes require a real-path browser check against `bun run dev:web`, including the primary
flow and an obvious error or empty state. Document anything that could not be exercised because an
external provider or fixture was unavailable.

## Schema and environment changes

- Any change to `packages/db/src/product-schema.ts`, `legacy-billing-schema.ts`, or
  `llm-broker-schema.ts` needs a reviewed Drizzle migration unless it is strictly a TypeScript-only
  model adjustment with no database effect.
- Never rewrite migration history or run production migrations from a development task.
- New env vars must be added to `.env.example`, the appropriate Infisical path, release preflight,
  and operational documentation.
- Web production secrets live in the `prod` `/web` deployment namespace; API secrets
  live in `prod` `/api`; runner secrets live in `prod` `/runner`; release credentials live in
  `prod` `/release`.

## Tooling

Biome owns formatting and import ordering. ESLint owns linting, including Next.js rules. Tests use
Vitest. Bun `1.3.2` and Node `20.20.0` or newer are required.

Useful review labels are `schema`, `env`, `auth`, `ci`, and `risk:high` for production data,
authentication, billing, or broad user flows.
