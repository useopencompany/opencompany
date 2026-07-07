# Deployment

Production uses Infisical as the secret source of truth, Vercel as the release control plane, and
Render for the long-lived agent runner.

## Runtime split

- Infisical stores and syncs runtime/release secrets.
- Vercel hosts `apps/web`, serves the Next.js UI, WorkOS callback routes, server actions, and the
  Inngest endpoint at `/api/inngest`.
- Render hosts `apps/runner`, the Bun/Fastify service that owns live agent runs, E2B sandboxes,
  model/tool streams, abort state, and Durable Stream transcript appends.
- Neon Postgres is shared by web, Inngest functions, and the runner.
- Inngest coordinates background functions, but it does not host live token streams.

Keep this split for V1. Vercel Queues/Workflow/Fluid Compute are useful later, but the current
runner is a dedicated live data plane rather than a short request handler.

## Release contract

Production releases are intentionally guarded:

1. Run CI on `main`.
2. Run Drizzle migrations against production Neon.
3. Build the Vercel web app for the exact commit.
4. Re-check that the release is still current.
5. Trigger the Render runner deploy, then deploy the prebuilt Vercel web app while Render builds.
6. Wait for the Render runner deploy for the exact commit.
7. Smoke check the canonical production web `/api/healthz` and runner `/healthz`.

The workflow lives in `.github/workflows/release-production.yml`. It runs automatically after the
`CI` workflow succeeds for a push to `main`, and it can still be manually triggered from GitHub
Actions. It is protected with `concurrency: production-release` so two production releases cannot
overlap. GitHub Actions keeps only the newest queued production release in that concurrency group;
older queued releases are cancelled automatically. A release that has already started is not killed
mid-flight, but automatic releases re-check `origin/main` before setup, before production changes,
and before deploy so stale commits skip the remaining expensive or mutating work.

After migrations and the final deploy freshness check, web and runner deployment wait time may
overlap. This keeps release latency down without starting production deploys for stale commits. A
failed Vercel deploy best-effort cancels the in-flight Render deploy, but cancellation is not a
rollback guarantee; if Render has already gone live, treat the failed workflow as requiring operator
follow-up.

The `CI` workflow uses branch/PR concurrency with `cancel-in-progress: true`, so a newer push to the
same PR or to `main` cancels superseded lint/typecheck/build/test work. This keeps rapid merge
bursts from spending Actions minutes on commits that can no longer release.

The web and Goat smoke checks use `PRODUCTION_WEB_URL` and `PRODUCTION_GOAT_URL` from Infisical
`prod` + `/release`, not the raw Vercel deployment URLs, so Vercel deployment protection can remain
enabled on generated preview-style URLs. In production the canonical web URL is
`https://my.opencompany.cloud`. The Better Stack status page monitors the same web `/api/healthz`,
Goat `/api/healthz`, and runner `/healthz` endpoints as the release smoke check, so keep those
health endpoints stable when changing deployment or monitoring behavior.

Release attribution is not managed as an Infisical secret. Vercel and Render expose commit metadata
to the server runtimes, and the production workflow injects `RELEASE_SHA` as
`NEXT_PUBLIC_OBSERVABILITY_RELEASE` during `vercel build` so browser Better Stack events group under
the same commit. Keep `OBSERVABILITY_RELEASE` unset in normal hosted deploys; reserve it for manual
or non-Git deploys where platform commit metadata is unavailable.

Production release history is recorded with GitHub Deployments, keyed by the released commit SHA. The
workflow creates a `production` deployment before migrations and marks it successful only after the
deploy and smoke checks complete. If an automatic release is superseded after the deployment record is
created but before deploy, the record is marked inactive. Use GitHub Deployments as the operational
audit trail for what is or was in production; `CHANGELOG.md` remains a product-facing summary and does
not drive deployment.

Vercel's build command no longer runs migrations. Migrations happen once, explicitly, before web and
runner deployment. Keep schema changes backwards compatible with the previous web and runner version
until the release has completed. Because web and runner deploys can now finish in either order, keep
web-runner contracts compatible in both directions for at least one release: new web must tolerate
the previous runner, and previous web must tolerate the new runner during the deployment window.

## Platform setup

### Vercel

Create/import the web project from this repo.

- Install command: `bun install --frozen-lockfile`
- Build command: `bun run vercel-build`
- Production branch: `main`
- Enable "Automatically expose System Environment Variables".
- Enable Skew Protection.
- If available, enable Rolling Releases with manual approval stages.
- Automatic Git deploys are disabled in `vercel.json` with `git.deploymentEnabled: false`.
  Keep this disabled so pull requests, including forks without Vercel access, do not create Vercel
  deployment checks. Production deploys are created by the GitHub Actions release workflow with
  `vercel deploy --prebuilt --prod`.

Set these in Infisical `prod` + `/web` and sync them into Vercel:

- `DATABASE_URL`
- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`
- `OPENCOMPANY_GITHUB_ORG`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_INTEGRATION_APP_ID`
- `GITHUB_INTEGRATION_APP_PRIVATE_KEY`
- `GITHUB_INTEGRATION_APP_SLUG`
- `GITHUB_INTEGRATION_APP_CLIENT_ID`
- `GITHUB_INTEGRATION_APP_CLIENT_SECRET`
- `GITHUB_INTEGRATION_STATE_SECRET`
- `INNGEST_EVENT_KEY`
- `INNGEST_SIGNING_KEY`
- `RUNNER_PUBLIC_URL`
- `RUNNER_INTERNAL_TOKEN`
- `DURABLE_STREAMS_URL`
- `DURABLE_STREAMS_TOKEN`
- optional analytics, feedback, and observability env vars

Forward production web logs to the Better Stack source `opencompany-web-production` using the
Vercel Better Stack integration or a Vercel Log Drain. Keep the source token in Vercel/Infisical,
not in git.

### Vercel Goat

`apps/goat` deploys as a separate manual Vercel project/domain for the experiment. Keep the project
root at the repo root and override the project build command:

- Install command: `bun install --frozen-lockfile`
- Build command: `bun run vercel-build:goat`
- Production branch: `main`
- Framework preset: Next.js
- Automatic Git deploys: off for v1; deploy manually after migrations and runner compatibility are
  confirmed.

Set the Goat project envs from [env-vars.md → Vercel Goat](./env-vars.md#vercel-goat). Register the
Goat redirect URI in the same WorkOS environment as the core app:

```text
https://<goat-domain>/auth/callback
```

The first Goat release needs the `goat` schema migration applied to the shared Neon database before
the app is served. Rollback is additive for the MVP: disabling the Goat Vercel project stops new
task creation without affecting core `public` schema data.

### Render

Create the runner from `render.yaml`.

- Service name: `opencompany-runner`
- Runtime: Docker
- Health check: `/healthz`
- Shutdown delay: `300` seconds, Render's documented maximum. Render sends `SIGTERM` to the old
  instance during deploys and follows with `SIGKILL` after this delay, so this is a mitigation for
  long runner turns, not a guarantee that every Rana run can finish before a deploy cuts it off.
- Auto deploy: off, so GitHub Actions controls release order
- API deploys: store `RENDER_SERVICE_ID` and `RENDER_API_KEY` in Infisical `prod` + `/release`

Set these in Infisical `prod` + `/runner` and sync them into Render:

- `DATABASE_URL`
- `RUNNER_INTERNAL_TOKEN`
- `RUNNER_STREAM_TOKEN_SECRET`
- `RUNNER_ALLOWED_ORIGINS`
- `DURABLE_STREAMS_URL`
- `DURABLE_STREAMS_TOKEN`
- `E2B_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY`
- `EXA_API_KEY` (required when Goat tasks are enabled)
- `RUNNER_GOAT_BROWSER_ENABLED` (optional; set `true` to allow Goat rendered-browser tasks)
- `BROWSERLESS_API_KEY` (required when Goat Browser is enabled with the production Browserless default)
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_INTEGRATION_APP_ID`
- `GITHUB_INTEGRATION_APP_PRIVATE_KEY`

Forward runner logs to the Better Stack source `opencompany-runner-production` using a Render Log
Stream. Keep the source token in Render/Infisical, not in git.

`RUNNER_ALLOWED_ORIGINS` must include the exact production web origin, for example
`https://app.example.com`. Add preview origins only if you intentionally allow previews to connect
to the production runner.

### Neon

Use a dedicated production branch/database and set the pooled connection string as `DATABASE_URL` in
Infisical `prod` + `/web` and `/runner`, and as `PRODUCTION_DATABASE_URL` in Infisical `prod` +
`/release`.

Before first real deployment:

- Enable backups/PITR.
- Confirm the production branch is not used by local development.
- Run `bun run db:migrate` once against production from the release workflow, not from a developer
  laptop.

### Inngest

Create a production Inngest app and connect it to:

```text
https://<production-web-domain>/api/inngest
```

Set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in Vercel. Do not set `INNGEST_DEV=1` in hosted
environments.

The production release workflow syncs the deployed app with Inngest after the web smoke check:

```bash
bun run release:inngest:sync
```

This sends `PUT https://<production-web-domain>/api/inngest`, which refreshes the function
definitions Inngest Cloud uses to invoke production jobs.

### WorkOS

Create or switch to the production WorkOS environment.

- Add the production redirect URI:
  `https://<production-web-domain>/auth/callback`
- Set `NEXT_PUBLIC_WORKOS_REDIRECT_URI` to the same value in Vercel.
- Generate a 32+ character `WORKOS_COOKIE_PASSWORD`.

### GitHub Work Integration

Create a separate production GitHub App for user-facing work repository integrations.

- Set callback URLs to:
  `https://<production-web-domain>/api/integrations/github/callback`
  `https://<production-goat-domain>/api/integrations/github/callback`
- Grant repository contents read/write and pull request read/write permissions.
- Leave webhooks inactive until a GitHub webhook ingestion route is deployed. When enabled, subscribe
  to pull request events used by `.agent` triggers: `opened`, `reopened`, `synchronize`, and
  `ready_for_review`.
- Install the App only on the orgs or repositories customers should connect.
- Set `GITHUB_INTEGRATION_APP_ID`, `GITHUB_INTEGRATION_APP_PRIVATE_KEY`,
  `GITHUB_INTEGRATION_APP_SLUG`, `GITHUB_INTEGRATION_APP_CLIENT_ID`,
  `GITHUB_INTEGRATION_APP_CLIENT_SECRET`, and a separate 32+ character
  `GITHUB_INTEGRATION_STATE_SECRET` in Vercel.

### GitHub Actions

Create a protected `production` environment in GitHub and add these environment variables:

- `INFISICAL_PROJECT_SLUG`
- `INFISICAL_MACHINE_IDENTITY_ID`
- `INFISICAL_ENV_SLUG` (optional, defaults to `prod`)
- `INFISICAL_DOMAIN` (optional, defaults to `https://eu.infisical.com`)

Store release secrets in Infisical `prod` + `/release`; see [secret-management.md](./secret-management.md).

The release workflow checks these with:

```bash
bun run release:preflight -- --release
```

## Local/operator commands

Check local env coverage:

```bash
bun run release:preflight
```

Check only web or runner env coverage:

```bash
bun run release:preflight -- --web
bun run release:preflight -- --runner
```

Run smoke checks against deployed services:

```bash
PRODUCTION_WEB_URL=https://my.opencompany.cloud \
RUNNER_PUBLIC_URL=https://opencompany-runner.onrender.com \
bun run release:smoke
```

## First release checklist

- CI is green on `main`.
- Infisical `prod` + `/web`, `/runner`, and `/release` are populated.
- Infisical syncs to Vercel and Render are enabled.
- GitHub Actions production vars for Infisical OIDC are set.
- WorkOS production callback works.
- Inngest production app can sync functions from `/api/inngest`.
- Neon backups/PITR are enabled.
- Render API deploy works for the runner service.
- `bun run release:preflight -- --release` passes in GitHub Actions.
- The first `Release Production` workflow finishes with smoke checks green.

## PR preview environments

A labeled PR can get a **full per-PR isolated stack** — its own Neon branch, runner,
Electric, Durable Streams, and Vercel web deploy — created on label/push and destroyed on
close. The load-bearing invariant: a preview runner must **never** poll the production
database. Isolation is structural (DB-per-preview) and enforced at runner boot.

This implements issue #351. Design notes live in the issue and the workspace plan
(`.context/preview-environments-plan.md`).

### Architecture (one stack per PR)

GitHub Actions is the single orchestrator (mirrors `release-production.yml`):

```text
labeled PR ──► .github/workflows/pr-preview.yml
                 ├─ await-ci: wait for the CI quality check (lint/typecheck/build/test) to pass — else skip
                 │  scripts/preview-provision.mjs
                 ├─ Neon branch  preview/pr-<n>  (forked from sanitized preview-seed, migrated, TTL)
                 ├─ Render runner   oc-preview-pr-<n>-runner   (builds Dockerfile.runner @ PR branch)
                 ├─ Render electric oc-preview-pr-<n>-electric (electricsql/electric image, secure)
                 ├─ Render streams  oc-preview-pr-<n>-streams  (in-memory @durable-streams/server)
                 └─ Vercel web deploy ──► alias pr-<n>.<PREVIEW_BASE_DOMAIN>, per-PR env injected
closed / unlabeled ──► scripts/preview-teardown.mjs  (delete all + Neon branch → drops the replication slot)
every 6h ─► .github/workflows/preview-reaper.yml  (desired = labeled-open PRs; destroys orphans/over-TTL)
```

- **Gating:** label-gated on `preview` (cost control). No label, no stack.
- **Merge policy:** PR previews are advisory. Do not require `PR Preview`,
  `Wait for CI to pass`, or `Provision preview stack` in branch protection/rulesets;
  keep the CI quality check as the merge gate. Preview failures still update the PR
  comment, plus GitHub Deployment status when a deployment record exists.
- **Data:** previews fork from a sanitized `preview-seed` branch, **never** prod `main`
  (no prod PII). The DB is seeded when the per-PR branch is first created and preserved
  across preview updates.
- **Base secrets:** Infisical `dev`; runner static runtime secrets currently reuse
  Infisical `prod` + `/runner`; per-PR dynamic values are minted by the orchestrator.
- **Safety gate:** `apps/runner/src/preview-guard.ts` refuses to boot a preview runner unless
  the attached Neon endpoint is verified (Neon API) to belong to its `NEON_BRANCH_ID`, and
  refuses to boot a prod runner that carries any preview identity.
- **Electric:** secure-by-default (`ELECTRIC_SECRET`, injected server-side by the web proxy).
  Its on-disk shape log is **not** disposable — set `PREVIEW_ELECTRIC_STORAGE_DIR` to a
  persistent volume, or treat restarts as a full reprovision (the default).

> ⚠️ **Render create-service payloads need a one-time live validation.** The exact
> `POST /v1/services` body is centralized in `scripts/lib/preview-render.mjs`
> (`build*ServiceSpec`). Run `node scripts/preview-provision.mjs --dry-run` (it prints every
> payload) and confirm against the Render API before the first real provision; adjust field
> names in that one file if Render rejects anything.

### One-time setup

Neon project **logical replication must be enabled** (project-wide, irreversible, restarts
computes — already done for this project).

1. **`preview-seed` Neon branch.** Fork from prod and sanitize (remove PII/secrets) with
   the bundled tooling:

   ```bash
   NEON_PARENT_BRANCH=<prod-branch> bun run preview:seed                            # create the branch
   psql "$SEED_DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/sql/preview-seed-sanitize.sql  # scrub PII/secrets (REQUIRED)
   # or: NEON_PARENT_BRANCH=<prod-branch> bun run preview:seed -- --apply-sanitize
   ```

   The sanitizer deletes credential/billing/transient rows, scrubs every customer-authored
   or identifying text/jsonb column, and ends with a **coverage guard**: it re-scans the live
   schema and aborts (rolling back the whole run) if any unreviewed content column exists.
   Run it with `ON_ERROR_STOP=1` so a guard failure is fatal — if it errors, classify the
   reported column(s) in `scripts/sql/preview-seed-sanitize.sql` and re-run before using the
   seed. This is why the seed must be re-sanitized after every schema change, not just every
   re-fork.

   Re-fork + re-sanitize on a cadence (`--refresh`) so the seed stays realistic. Electric
   uses the branch owner role by default; `scripts/sql/preview-seed-electric-role.sql` is
   an optional least-privilege hardening to apply + test later.
2. **Vercel.** Attach `*.preview.opencompany.cloud` (wildcard) and
   `oauth.opencompany.cloud` to the existing web project. Populate the Vercel **Preview**
   environment base values from Infisical `dev` + `/web`.
3. **Inngest.** Use the existing Inngest Cloud account with Branch Environments. Add the
   branch-environment `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` to the Vercel Preview
   environment base values (via Infisical/Vercel sync or the Inngest Vercel integration).
   Keep `INNGEST_DEV` unset. The PR workflow injects `INNGEST_ENV=preview-pr-<n>` and
   `INNGEST_SERVE_ORIGIN=https://pr-<n>.<preview-domain>`, then runs a `PUT /api/inngest`
   sync against that deterministic custom domain after each web deploy, so every preview gets
   isolated events, logs, delayed jobs, and function definitions. The Vercel project should keep
   preview custom domains outside deployment protection, or Inngest function invocations will be
   blocked. If you later install the Inngest Vercel integration and use protected deployment URLs
   instead of the custom preview domain, configure Protection Bypass for Automation in the Inngest
   Vercel integration settings.
4. **GitHub.** Create the `preview` environment and label. Set repo `vars` (see
   [env-vars.md → Preview Environments](./env-vars.md#preview-environments-per-pr)):
   at minimum `PREVIEW_BASE_DOMAIN`, plus the Infisical OIDC `vars`.
5. **Infisical.** In the provision path (`dev` + `/release` by default) add `NEON_API_KEY`,
   `NEON_PROJECT_ID`, `RENDER_API_KEY`, and `VERCEL_TOKEN/ORG_ID/PROJECT_ID` (the same
   `RENDER_API_KEY` / `VERCEL_*` model as the prod release CI; `RENDER_OWNER_ID` is
   optional — auto-resolved from the API). Broaden the OIDC machine identity so the
   `PR Preview` and `Preview Reaper` workflows may read it. The `PR Preview` workflow also
   reads runner runtime secrets from `prod` + `/runner` by default
   (`PREVIEW_RUNNER_INFISICAL_ENV_SLUG` / `PREVIEW_RUNNER_INFISICAL_SECRET_PATH`) so preview
   runners can boot with E2B, AI Gateway, integration encryption, and GitHub App credentials.
6. **Better Stack / Render logs.** Create one shared Better Stack Render log source for preview
   runner logs, normally `opencompany-runner-preview`. Store its syslog endpoint and source token
   in Infisical `dev` + `/release` as `PREVIEW_RENDER_LOG_ENDPOINT` and
   `PREVIEW_RENDER_LOG_TOKEN` so `scripts/preview-provision.mjs` can apply a Render resource log
   stream override to each preview runner. If using a workspace-level Render Log Stream instead,
   point it at the same source and enable **Include logs from preview instances**. Search the shared
   source by `preview_pr_number` and `session_id`.
7. **WorkOS.** On the preview AuthKit env, register wildcard **login** and **sign-out**
   redirects (`https://*.preview.opencompany.cloud/...`) and keep a concrete default (a
   wildcard cannot be the default).
8. **Google OAuth.** In Google Cloud Console, add
   `https://oauth.opencompany.cloud/api/google/callback` as an authorized redirect URI.
   Set `GOOGLE_OAUTH_CALLBACK_URL` to that same value in the Vercel/Infisical envs used by
   previews, and in production if production should also route through the broker.
9. **Shared services (guardrails).** Use capped preview E2B + AI Gateway keys (or accept
   dev keys), and a sandbox GitHub org/App (or accept the dev org). Stripe can degrade
   gracefully in preview; Inngest is required for delayed/background behavior such as the
   5-minute memory pass.

### Operating a preview

- **Create / update:** add the `preview` label (or push to an already-labeled PR). The PR
  gets a comment with the URL + stack links.
- **Reset data:** remove the `preview` label or close the PR to tear down the stack, then
  add the label/reopen to create a fresh branch from the seed.
- **Destroy:** close the PR or remove the `preview` label. The reaper is the backstop.
- **Local script use:** `bun run preview:provision` / `bun run preview:teardown`
  (`--dry-run` supported); `node scripts/preview-reaper.mjs --dry-run` to preview cleanup.

### First preview — verification checklist

See the step-by-step in the PR review thread / plan. In short: confirm setup (§one-time
setup), open a throwaway PR, add the `preview` label, watch `PR Preview` go green, then
verify the alias loads + auth works, the runner `/healthz` and Electric `/v1/health`
respond, a real agent session streams, and finally that closing the PR tears everything
down (and that the prod runner still refuses any stray preview env).
