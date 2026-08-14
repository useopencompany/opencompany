# Contributing

opencompany is maintainer-led open source. Focused documentation, reproducible bug fixes, tests,
small UX improvements, and scoped integrations are welcome. Maintainers retain roadmap and final
design decisions while the project builds public contribution capacity.

## Community setup

```bash
bun install --frozen-lockfile
bun run dev:community
```

In a second terminal, run `bun run smoke:local`. This credential-free path boots web, API, runner,
and embedded Postgres with provider-backed capabilities explicitly disabled. It is supported for
development, not production self-hosting. Internal maintainers may instead use `bun run setup` and
`bun run dev:web` with opencompany provider access.

## Where changes belong

| Change type | Primary location | Boundary |
| --- | --- | --- |
| UI, auth shell, or presentation relay | `apps/web` | Call typed `/v1` or fixed read models; never import database adapters. |
| Public contract, DTO, event, or generated client | `packages/protocol` | Update tests and the reviewed OpenAPI artifact. |
| Framework-free application service or port | `packages/core` | No HTTP, database, queue, or UI framework dependencies. |
| Postgres repository or storage adapter | `packages/db` | Implement core ports; do not introduce wire DTOs or app imports. |
| Public API or provider ingress composition | `apps/api` | Compose protocol, core, database, and provider boundaries. |
| Durable worker, scheduler, sandbox, or background integration | `apps/runner` | Persist directly through repositories; do not call web or the public API for execution state. |
| Physical schema change | `packages/db/src/*schema.ts` and a new file in `drizzle/` | Never rewrite applied migrations; run migration checks. |
| Public product/API documentation | `apps/docs/content/docs` | Generated endpoint docs come from protocol OpenAPI. |
| Contributor, architecture, operator, ADR, or proposal documentation | `docs` | ADRs are accepted history; future concepts are not current behavior. |
| Provider deployment definition | `integrations/<provider>` | External deploys require exact-target verification and owner approval. |

Read the local README in each primary app/package before crossing a boundary.

## Design approval

Open an issue or design discussion and get maintainer agreement **before** implementing architecture,
schema, authentication, billing, deployment, or broad refactor work. The same applies to changes
that introduce a new runtime, public contract family, dependency direction, or production operator
promise. A discussion is optional for focused docs, tests, reproducible fixes, and small UX changes
that preserve accepted boundaries.

Keep pull requests scoped to the accepted design. Do not create a performative `good first issue`
backlog or promise governance/response SLAs that maintainers have not staffed.

## DCO sign-off

Every commit must carry a Developer Certificate of Origin sign-off using the contributor's real
name and an email they are entitled to use:

```bash
git commit -s -m "fix: describe the change"
```

The resulting `Signed-off-by: Name <email>` line certifies that the contributor has the right to
submit the work under the repository license. Add the sign-off to every commit in a pull request;
do not paste another person's sign-off.

## Select and run checks

Run focused package checks while developing, then the CI-equivalent gates before review:

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

TruffleHog is required for the local secret scan. Use Turbo filters such as
`bun run test --filter @opencompany/api` for focused work. Contract changes also require
`bun --filter @opencompany/protocol openapi:check`; community setup changes require an actual
`bun run dev:community` plus `bun run smoke:local` run.

UI changes require a real browser check against `bun run dev:web` or `dev:community`, covering the
main flow and one obvious error or empty state. Document any provider-dependent path that could not
be exercised.

## Schema, environment, and review safety

- Every physical schema change needs a new reviewed Drizzle migration.
- Never rewrite migration history or run production migrations from a development task.
- New env vars must be added to `.env.example`, the appropriate Infisical path, release preflight,
  and operational documentation.
- Web production secrets live in the `prod` `/web` deployment namespace; API secrets
  live in `prod` `/api`; runner secrets live in `prod` `/runner`; release credentials live in
  `prod` `/release`.
- Treat pull requests as untrusted input. No contribution should require secrets, paid providers,
  deployment permission, or access to opencompany accounts to receive useful CI feedback.
- High-risk changes to production data, authentication, billing, deployment, or broad user flows
  need explicit maintainer review and real-path verification.

Biome owns formatting/import ordering, ESLint owns lint rules, and Vitest owns tests. Bun `1.3.2`
and Node `20.20.0` or newer are required.
