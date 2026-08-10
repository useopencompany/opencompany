# Deployment

Production releases are defined by `.github/workflows/release-production.yml` and target three
surfaces:

| Surface | Host | Responsibility |
| --- | --- | --- |
| Goat | Vercel | product UI, APIs, callbacks, webhooks, cron routes |
| Runner | Render | durable workers, internal transports, LLM broker |
| Marketing | Vercel | public marketing site |

## Release flow

Merges to `main` trigger a release after CI succeeds. The workflow calculates affected surfaces,
loads release credentials from Infisical `prod` `/release`, validates Goat and runner configuration,
builds artifacts, runs production migrations once, deploys the selected surfaces, waits for Render,
and runs release-aware Goat and runner health checks. Automatic releases re-check the current main
SHA before migrations and deploy so a superseded run cannot publish stale code.

Manual dispatch can force surfaces and health checks. Do not bypass preflight or branch protection.

## Configuration ownership

- Goat values: Infisical `prod` `/goat`, synced to the Goat Vercel project.
- Runner values: Infisical `prod` `/runner`, synced to the Render service.
- Release credentials and canonical URLs: Infisical `prod` `/release`.

Run `bun run infisical:release:preflight` to validate the release group. The hosted workflow also
checks Vercel project metadata for sensitive values that cannot be read back through an env pull.

## Migrations

The release runs `bun run db:migrate` against `PRODUCTION_DATABASE_URL` before deploying changed
surfaces. Migrations must be backward compatible with the currently deployed Goat and runner.
Never use a routine product release to drop compatibility tables or rewrite migration history.

## Health checks and rollback

Goat and runner `/healthz` responses include the deployed release. `scripts/release-smoke.mjs`
requires the expected SHA, preventing a healthy but stale deployment from passing. A failed Vercel
promotion cancels an in-flight Render deploy where possible.

Application rollback means redeploying a known-good commit through the same release workflow.
Database migrations are forward-only; design them so the previous application remains compatible.
External webhook/OAuth rollback may also require restoring a provider dashboard URL, which must be
called out in the pull request.

## Stripe production endpoint

The live Stripe webhook must target `${PRODUCTION_GOAT_URL}/api/stripe/webhook` and use the same
signing secret as `GOAT_STRIPE_WEBHOOK_SECRET` in Goat. After billing or deployment changes, send a
signed probe and replay a representative live event, confirm a `2xx`, and verify idempotent
processing in `goat.stripe_webhook_events`. The billing compatibility path intentionally continues
to update retained public-schema customer/subscription/credit tables.
