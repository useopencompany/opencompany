# Deployment

Production releases are defined by `.github/workflows/release-production.yml` and target four
surfaces:

| Surface | Host | Responsibility |
| --- | --- | --- |
| Web | Vercel | product UI, APIs, callbacks, webhooks, cron routes |
| Canonical Chat API | Render | Hono `/v1`, SSE, attachment commands, authorized read models |
| Runner | Render | durable workers, internal transports, LLM broker |
| Marketing | Vercel | public marketing site |

## Release flow

Merges to `main` trigger a release after CI succeeds. The workflow calculates affected surfaces,
loads release credentials from Infisical `prod` `/release`, validates web/API/runner configuration,
pulls the current Vercel production environment before each prebuilt Vercel build, builds artifacts,
runs production migrations once, deploys the selected surfaces, waits for both Render services, and
runs release-aware web/API/runner health checks. Automatic releases re-check the current main SHA
before migrations and deploy so a superseded run cannot publish stale code.

Manual dispatch can force surfaces and health checks. Do not bypass preflight or branch protection.

## `apps/web` production root cutover

Issue #1163 moves the existing Vercel application's repository root without renaming the hosted
project or its `GOAT_VERCEL_PROJECT_ID` credential. This is a coordinated production gate:

1. `@louismorgner`, the repository and Actions CODEOWNER, owns the Vercel setting change and
   confirmation. A coding agent must not make it.
2. After the path-changing PR is green and ready to merge, change the existing Vercel project's
   **Root Directory** from `apps/goat` to `apps/web` in the coordinated merge window. Changing this
   setting does not replace the currently promoted deployment.
3. Confirm the Vercel API/UI reports `rootDirectory: apps/web`, then merge immediately. Release
   automation checks this exact value before building or deploying the web surface.
4. After deployment, verify `/api/healthz`, the sign-in flow, a signed Stripe webhook delivery,
   authenticated Electric shape synchronization, foreground chat, a durable task/workflow turn,
   Brain read/capture, billing, and a coding workspace round trip through the runner.

If the cutover cannot be confirmed, leave the PR open. Rollback is the inverse coordinated
operation: restore the Vercel root to `apps/goat`, revert the path/package commit on `main`, redeploy
that revert, and repeat the same smoke checks. This topology change has no database or data rollback.

## Configuration ownership

- Web values: the retained Infisical compatibility path `prod` `/goat`, synced to the existing Vercel project.
- API values: Infisical `prod` `/api`, synced to the `opencompany-api` Render service.
- Runner values: Infisical `prod` `/runner`, synced to the Render service.
- Release credentials, Render service IDs, and canonical URLs: Infisical `prod` `/release`.

Run `bun run infisical:release:preflight` to validate the release group. The hosted workflow also
checks Vercel project metadata for sensitive values that cannot be read back through an env pull.

## Migrations

The release runs `bun run db:migrate` against `PRODUCTION_DATABASE_URL` before deploying changed
surfaces. Migrations must be backward compatible with the currently deployed web app and runner.
Never use a routine product release to drop compatibility tables or rewrite migration history.

## Health checks and rollback

Web, API, and runner `/healthz` responses include the deployed release. `scripts/release-smoke.mjs`
requires the expected SHA, preventing a healthy but stale deployment from passing. A failed Vercel
promotion cancels in-flight Render deploys where possible.

Application rollback means redeploying a known-good commit through the same release workflow.
Database migrations are forward-only; design them so the previous application remains compatible.
External webhook/OAuth rollback may also require restoring a provider dashboard URL, which must be
called out in the pull request.

For canonical Chat, the immediate rollback is configuration-only: set
`NEXT_PUBLIC_GOAT_HEADLESS_CHAT=false` and redeploy web. Existing canonical Runs continue to settle
through the API and runner. The release must pull the updated Vercel production environment before
building because this public flag and `NEXT_PUBLIC_GOAT_API_ORIGIN` are compiled into the browser
bundle. Production browser traffic connects directly to `https://api.opencompany.chat`; the web and
API runtimes share `WORKOS_COOKIE_DOMAIN=opencompany.chat`, and the API allows credentialed CORS only
from the production web origin. Server-only `GOAT_API_ORIGIN` retains the same-origin fallback route,
but it is not the active production streaming path.

## Stripe production endpoint

The live Stripe webhook remains `${PRODUCTION_GOAT_URL}/api/stripe/webhook`; do not change the
Stripe Dashboard URL. Web streams the signed raw body to the API-owned handler, whose
`GOAT_STRIPE_WEBHOOK_SECRET` lives in Infisical `prod` `/api`. The handler keeps Goat subscription,
credit-ledger, and auto-refill idempotency authoritative and continues updating the retained
public-schema billing tables for legacy product events.
