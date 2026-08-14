# Deployment

Production releases are defined by `.github/workflows/release-production.yml` and target four
surfaces:

| Surface | Host | Responsibility |
| --- | --- | --- |
| Web | Vercel | product presentation, WorkOS browser shell, health/static delivery, and narrow public URL or cron relays |
| Product API | Render | authenticated `/v1` resources, provider ingress, OpenAPI, SSE, attachment commands, and authorized read models |
| Runner | Render | durable Run execution, schedules, ingestion, integration workers, sandboxes, internal transports, and the LLM broker |
| Marketing | Vercel | public marketing site |

The Vercel web project root is `apps/web`; the marketing project root is `apps/marketing`. Release
automation verifies both values before building. The API and runner are separate Render services.

## Release flow

Merges to `main` trigger a release after CI succeeds. The workflow calculates affected surfaces,
loads release credentials from Infisical `prod` `/release`, validates web/API/runner configuration,
pulls the Vercel production environment before each prebuilt Vercel build, builds artifacts, runs
production migrations once, deploys the selected surfaces, waits for the Render services, and runs
release-aware health checks. It rechecks the current `main` SHA before migrations and deployment so
a superseded run cannot publish stale code.

Manual dispatch can force surfaces and health checks. Do not bypass preflight or branch protection.

## Configuration ownership

- Web: retained Infisical deployment path `prod` `/goat`, synced to the existing Vercel project.
- API: Infisical `prod` `/api`, synced to the `opencompany-api` Render service.
- Runner: Infisical `prod` `/runner`, synced to the runner Render service.
- Release: Infisical `prod` `/release`, containing deployment credentials, service/project IDs,
  production URLs, and the migration database URL.

Run `bun run infisical:release:preflight` to validate the release group. The hosted workflow also
checks Vercel project metadata and required host values that cannot be verified through a normal
environment pull.

## Migrations

The release runs `bun run db:migrate` against `PRODUCTION_DATABASE_URL` before deploying changed
surfaces. Migrations must be additive and compatible with the currently deployed API and runner as
well as the previous safe application revision. Never use a routine release to drop retained
compatibility tables or rewrite migration history.

## Health checks and recovery

Web and API `/healthz` responses include both the deployed release and canonical protocol version;
the runner reports its deployed release. `scripts/release-smoke.mjs` requires the expected SHA,
preventing a healthy but stale deployment from passing. A failed Vercel promotion cancels in-flight
Render deploys where possible.

Application rollback redeploys a known-good commit through the same protected release workflow.
Database migrations remain forward-only. Accepted Runs keep their stable IDs and continue through
the API/runner path; do not reintroduce a web execution path or move work to a retired queue.

Canonical Chat is fix-forward. Existing Runs continue to settle through the API and runner while a
corrective release is prepared. Production browser traffic connects directly to
`https://api.opencompany.chat`; the web and API runtimes share
`WORKOS_COOKIE_DOMAIN=opencompany.chat`, and the API allows credentialed CORS only from the
production web origin. `NEXT_PUBLIC_GOAT_API_ORIGIN` is compiled into the browser bundle, while
Server Components use `GOAT_API_ORIGIN`. Message commands require the matching
`X-OpenCompany-Protocol-Version` header. A hard protocol cutover intentionally rejects already-open
stale tabs with a refresh instruction; it does not normalize their payload through retired schemas.

External webhook or OAuth recovery may require restoring a provider dashboard URL. Historical web
URLs intentionally remain stable where the web app is a byte-preserving relay to API-owned ingress;
call out any provider URL change and its recovery plan in the pull request.

## Stripe production endpoint

Stripe calls `${PRODUCTION_GOAT_URL}/api/stripe/webhook`. The web route streams the signed raw body
to the API-owned handler; it does not verify or persist the event. `GOAT_STRIPE_WEBHOOK_SECRET`
lives in Infisical `prod` `/api`. The API owns subscription, credit-ledger, auto-refill, and webhook
idempotency while preserving the retained billing tables required by current contracts.
