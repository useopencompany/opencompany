# Authentication

The OpenCompany web app uses WorkOS AuthKit. `apps/web/lib/workos.ts` owns the canonical app URL and redirect URI;
`apps/web/lib/auth.ts` maps the WorkOS identity to Goat users and workspaces.

Local development uses `GOAT_NEXT_PUBLIC_APP_URL=https://localhost:3443` and
`GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://localhost:3443/auth/callback` by default. Production
values live in Infisical `prod` `/goat` and must match the WorkOS dashboard exactly.

Canonical browser Chat uses the separately deployed first-party API at `api.opencompany.chat`.
Production scopes the encrypted WorkOS session cookie to `WORKOS_COOKIE_DOMAIN=opencompany.chat` so
both the web and API hosts receive it. A same-origin web bootstrap migrates existing host-only
sessions before the first direct API request, and sign-out clears both cookie scopes. The API's
`API_BROWSER_ORIGINS` allowlist controls credentialed CORS, while unsafe cookie-authenticated
requests additionally require an exact allowed `Origin`; bearer-authenticated clients keep their
existing contract.

The runner does not accept browser sessions. Private web-to-runner requests use
`RUNNER_INTERNAL_TOKEN`, and browser-reachable runner transports use scoped signed tickets plus
`RUNNER_ALLOWED_ORIGINS`. Claude Code receives only a short-lived capability bound to its persisted
session, Run, Attempt, lease, and expiry. The runner re-derives Actor, workspace, membership, and
live execution authority from Postgres; no user/workspace identifier, provider credential, or raw
internal token enters the sandbox.

OpenCompany's external integrations use provider-specific OAuth state secrets and encrypted credential
storage. Google integrations use direct Goat callback routes; GitHub, Slack, Linear, HubSpot, X,
and MCP connectors document their routes in `.env.example`. Never expose server credentials through
`NEXT_PUBLIC_*` variables.
