---
name: prod-debug
description: Use when debugging production incidents, prod state, logs, errors, secrets, credentials, Better Stack telemetry, Infisical prod env vars, or read-only production database inspection for opencompany.
---

# Production Debugging

Keep this workflow small, read-only by default, and secret-safe.

## Sources of truth

- Credentials and env vars: Infisical. Do not ask for, paste, log, or commit secret values.
- Logs and errors: Better Stack. Prefer the Better Stack MCP tools over guessing query syntax.
- Database state: Neon Postgres via the production env key from Infisical. Inspect only; do not migrate, write, seed, or run destructive SQL unless the user explicitly asks.

## First checks

1. Identify the failing surface: web app, runner, release, GitHub integration, Inngest, auth, or database.
2. Check Better Stack:
   - Production web logs: `opencompany-web-production` (`source_id=2460454`)
   - Production runner logs: `opencompany-runner-production` (`source_id=2460456`)
   - Next.js error app: `web app` (`application_id=2458614`)
3. Check credentials through Infisical without printing values:
   - Runtime paths: `prod` + `/web`, `prod` + `/runner`
   - Release/debug path: `prod` + `/release`
   - Production DB key for release/debug commands: `PRODUCTION_DATABASE_URL`

## Safe command patterns

Use Infisical injection for production credentials:

```bash
infisical run --env=prod --path=/release -- sh -c 'test -n "$PRODUCTION_DATABASE_URL" && echo PRODUCTION_DATABASE_URL=set'
```

For read-only DB inspection, map the production key into the app's expected `DATABASE_URL`:

```bash
infisical run --env=prod --path=/release -- sh -c 'DATABASE_URL="$PRODUCTION_DATABASE_URL" <read-only command>'
```

Use `select` queries only. Avoid updates, deletes, inserts, DDL, migrations, seeds, queue mutation, or replaying jobs.

## Better Stack query rules

- Start by listing/getting the source or application details, then get query instructions for that source before writing SQL.
- For log SQL, always use time filters, `LIMIT`, and nullable JSON extraction.
- If direct SQL reports a cluster or credential mismatch, create/use the correct Better Stack cloud connection for the source's region and never print the returned credentials.
- Summaries can include counts, timestamps, patterns, and redacted examples. Do not include tokens, cookies, auth headers, connection strings, or customer-sensitive payloads.

## Reporting

State what was checked, the time window, the production source or env path used, and whether the evidence points to logs, errors, credentials, DB state, or code behavior. Call out anything unverified.
