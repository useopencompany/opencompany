# Secret Management

Infisical is the source of truth for runtime and release secrets. Vercel, Render, and GitHub
Actions are delivery targets, not places where we hand-edit values.

## Shape

Use one Infisical project:

```text
opencompany
```

Use the standard environment slugs:

```text
dev
staging
prod
```

Use secret paths by deployment surface:

| Path | Used by | Purpose |
|---|---|---|
| `/web` | Vercel web, local web | Next.js app, WorkOS, Inngest, GitHub App, analytics, feedback, runner client config. |
| `/runner` | Render runner, local runner | Fastify runner, E2B, AI Gateway, runner auth, GitHub App Brain sync. |
| `/release` | GitHub Actions release workflow | Production migration/deploy orchestration. |

For local `dev`, keep Infisical focused on shared non-database secrets. The existing setup script
creates a branch-specific Neon `DATABASE_URL` in `.env.local`, and local Inngest is injected by the
dev scripts with `INNGEST_DEV=1`.

This creates a little duplication inside Infisical for hosted values like `DATABASE_URL`,
`RUNNER_INTERNAL_TOKEN`, and GitHub App credentials. That is acceptable for V1 because the
duplication is centralized in one product instead of spread across every platform. Later, use
Infisical secret imports/references to reduce duplication.

## Local Setup

Log in and link the repo:

```bash
infisical login
infisical init
```

`infisical init` creates `.infisical.json`. It does not contain secrets and can be committed.

Run local setup first so `.env.local` gets shared Infisical dev values and a branch-specific Neon
`DATABASE_URL`:

```bash
bun run setup
```

If a developer should use their own Neon project instead of a shared team Neon project, create a
personal override file before running setup:

```bash
bun run setup:personal
```

Then set `NEON_PROJECT_ID` in `.env.override.local`. That file is gitignored, survives
`bun run env:pull`, and takes precedence over `.env.local`.

When `.infisical.json` exists, setup pulls shared dev values from Infisical `dev` + `/web` and
`/runner`. There is no Vercel env-pull fallback.

Then run development from `.env.local`:

```bash
bun run dev
```

This is the default local workflow. Use direct Infisical injection only when you intentionally do not
want to rely on the synced `.env.local` shared values:

```bash
bun run infisical:dev
```

Run only one side:

```bash
bun run infisical:dev:web
bun run infisical:dev:runner
```

Export local env files when tools need a real `.env.local`:

```bash
bun run infisical:export
```

The export command pulls `dev` secrets from `/web` and `/runner` into `.env.local`, while preserving
existing `DATABASE_URL`, `NEON_BRANCH`, and `INNGEST_DEV`. Those are local runtime values managed by
`bun run setup` and the dev scripts.

## Initial Secret Upload

After `infisical init`, you can upload shared values from an existing local env file without placing
secret values in shell history:

```bash
infisical secrets set --env=dev --path=/web --file .env.local
```

Do not keep `DATABASE_URL`, `NEON_BRANCH`, or `INNGEST_DEV` in Infisical `dev` for normal local
development. They should remain local-only so each worktree gets its own Neon branch and local
Inngest dev mode.

For Infisical `dev`, `/web` should include:

- `NEON_PROJECT_ID`
- WorkOS vars
- GitHub App vars
- runner connection vars
- optional Linear, analytics, and observability vars

For Infisical `dev`, `/runner` should include:

- runner auth vars
- `RUNNER_ALLOWED_ORIGINS`
- `E2B_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY`
- GitHub App vars
- optional hosted tool and observability vars

Hosted Inngest keys belong in `staging`/`prod`, not local `dev`.

For production, prefer filling values directly in the Infisical dashboard so you do not mix local and
production credentials. Use CLI upload only from a production-specific file that is never committed.

## Vercel Sync

In Infisical:

1. Create a Vercel connection.
2. Add a Vercel secret sync.
3. Source: `prod` + `/web`.
4. Destination: OpenCompany Vercel project, Production environment.
5. Initial behavior: import first if Vercel already has values, then make Infisical authoritative.
6. Enable auto-sync.

Repeat for:

- `dev` + `/web` -> Vercel Development
- `staging` + `/web` -> Vercel Preview

## Render Sync

In Infisical:

1. Create a Render connection.
2. Add a Render secret sync.
3. Source: `prod` + `/runner`.
4. Destination: `opencompany-runner` Render service.
5. Initial behavior: import first if Render already has values, then make Infisical authoritative.
6. Enable auto-sync.

## GitHub Actions Release

The production release workflow fetches secrets from Infisical at runtime with OIDC, so GitHub does
not need long-lived Vercel/Render/Neon secrets.

In Infisical:

1. Create a machine identity for GitHub Actions OIDC.
2. Restrict it to this repository and the `Release Production` workflow.
3. Grant it read access to `prod` + `/release`.
4. Copy the identity id.

In the GitHub repository `production` environment, add variables:

| Variable | Secret? | Value |
|---|---:|---|
| `INFISICAL_PROJECT_SLUG` | No | The Infisical project slug. |
| `INFISICAL_MACHINE_IDENTITY_ID` | No | The machine identity id. |
| `INFISICAL_ENV_SLUG` | No | Usually `prod`. Optional because workflow defaults to `prod`. |
| `INFISICAL_DOMAIN` | No | Infisical API origin. Defaults to `https://eu.infisical.com`. |

Put these keys in Infisical `prod` + `/release`:

| Secret | Purpose |
|---|---|
| `PRODUCTION_DATABASE_URL` | Production Neon URL for migrations. |
| `VERCEL_TOKEN` | Vercel deploy token. |
| `VERCEL_ORG_ID` | Vercel org/team id. |
| `VERCEL_PROJECT_ID` | Vercel project id. |
| `RENDER_SERVICE_ID` | Render service id for the runner. |
| `RENDER_API_KEY` | Render API key used to trigger and poll runner deploys. |
| `PRODUCTION_WEB_URL` | Canonical production web URL for smoke checks. |
| `RUNNER_PUBLIC_URL` | Canonical production runner URL for smoke checks. |

The workflow maps `PRODUCTION_DATABASE_URL` to `DATABASE_URL` before running Drizzle migrations.
Do not store per-commit release values in Infisical. The release workflow derives them from GitHub
and injects them into the Vercel build, while Vercel and Render expose their own git commit metadata
to server runtimes.

## Operational Rule

Normal changes:

1. Edit values in Infisical.
2. Let syncs update Vercel/Render.
3. Run `bun run infisical:release:preflight` locally or let GitHub Actions run `bun run release:preflight`.
4. Merge to `main` and let `Release Production` run after CI succeeds, or manually dispatch it from `main`.

Break-glass changes:

- It is okay to edit Vercel or Render directly during an incident.
- After the incident, copy the final value back into Infisical and resync.

## References

- Infisical CLI quickstart: https://infisical.com/docs/cli/usage
- Infisical Vercel sync: https://infisical.com/docs/integrations/secret-syncs/vercel
- Infisical Render sync: https://infisical.com/docs/integrations/secret-syncs/render
- Infisical GitHub Actions OIDC: https://infisical.com/docs/integrations/cicd/githubactions
