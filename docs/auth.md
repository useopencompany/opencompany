# Authentication

The OpenCompany web app uses WorkOS AuthKit. `apps/web/lib/workos.ts` owns the canonical app URL and redirect URI;
`apps/web/lib/auth.ts` maps the WorkOS identity to Goat users and workspaces.

Local development uses `GOAT_NEXT_PUBLIC_APP_URL=https://localhost:3443` and
`GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://localhost:3443/auth/callback` by default. Production
values live in Infisical `prod` `/goat` and must match the WorkOS dashboard exactly.

The runner does not accept browser sessions. Private web-to-runner requests use
`RUNNER_INTERNAL_TOKEN`, and browser-reachable runner transports use scoped signed tickets plus
`RUNNER_ALLOWED_ORIGINS`.

OpenCompany's external integrations use provider-specific OAuth state secrets and encrypted credential
storage. Google integrations use direct Goat callback routes; GitHub, Slack, Linear, HubSpot, X,
and MCP connectors document their routes in `.env.example`. Never expose server credentials through
`NEXT_PUBLIC_*` variables.
