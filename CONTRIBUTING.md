# Contributing

Keep pull requests focused, reviewable, and fully verified.

## Local checks

Run the CI-equivalent gates before opening a pull request:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run build
bun run test
bun run db:migrations:check
bun run secrets:check
```

Run `bun run openapi:check` after any change to `packages/protocol/src/{schemas,events,routes}.ts`;
regenerate the committed artifact with `bun run openapi:generate` and commit the diff.

TruffleHog must be installed for the local secret scan. CI runs the same scan on pull requests.
For focused checks, use Turborepo filters such as `bun run test --filter @opencompany/web` and
`bun run test --filter @opencompany/runner`.

UI changes require a real-path browser check against `bun run dev:web`, including the primary
flow and an obvious error or empty state. Document anything that could not be exercised because an
external provider or fixture was unavailable.

## Schema and environment changes

- Any change to `packages/db/src/goat-schema.ts`, `legacy-billing-schema.ts`, or
  `llm-broker-schema.ts` needs a reviewed Drizzle migration unless it is strictly a TypeScript-only
  model adjustment with no database effect.
- Never rewrite migration history or run production migrations from a development task.
- New env vars must be added to `.env.example`, the appropriate Infisical path, release preflight,
  and operational documentation.
- Goat production secrets live in `prod` `/goat`; runner secrets live in `prod` `/runner`; release
  credentials live in `prod` `/release`.

## Tooling

Biome owns formatting and import ordering. ESLint owns linting, including Next.js rules. Tests use
Vitest. Bun `1.3.2` and Node `20.20.0` or newer are required.

Useful review labels are `schema`, `env`, `auth`, `ci`, and `risk:high` for production data,
authentication, billing, or broad user flows.
