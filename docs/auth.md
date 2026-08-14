# Authentication

OpenCompany uses WorkOS AuthKit for browser sessions. `apps/web/lib/workos.ts` owns the canonical app
URL and redirect URI. The web sign-in/callback/sign-out routes and `activateGoatWorkspace` are
permanent browser-shell responsibilities: they handle framework redirects, SSO/MFA flows, AuthKit
session re-sealing, and presentation cookies.

Product identity belongs to the canonical API. `GET /v1/identity` resolves the verified WorkOS
identity, performs bounded membership adoption, and returns the credential-free user/workspace view.
`POST /v1/identity/sync` owns user synchronization and authentication completion. The API performs
all associated persistence reads and writes; web does not import the database.

`apps/web/lib/auth.ts` remains the Server Component resolver used throughout the UI. It calls the
identity resource under React `cache()`, preserving one request-scoped resolution and the existing
consumer semantics without creating another identity backend.

Local development uses `GOAT_NEXT_PUBLIC_APP_URL=https://localhost:3443` and
`GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://localhost:3443/auth/callback` by default. Production
values live in Infisical `prod` `/goat` and must match the WorkOS dashboard exactly.

## Browser/API session boundary

Production scopes the encrypted WorkOS session cookie to
`WORKOS_COOKIE_DOMAIN=opencompany.chat` so both web and API hosts receive it. A same-origin web
bootstrap migrates an existing host-only session before the first direct API request, and sign-out
clears both cookie scopes.

Every `/v1` route authenticates its caller. Most routes require a fully resolved Actor and workspace.
Identity and onboarding routes use a narrower verified-identity tier because an onboarded Actor does
not exist yet; they do not accept client-supplied user or workspace authority.

`API_BROWSER_ORIGINS` controls credentialed CORS. Unsafe cookie-authenticated requests additionally
require an exact allowed `Origin`; bearer-authenticated clients retain their token contract.

## Runner and integrations

The runner does not accept browser sessions. Private control requests use `RUNNER_INTERNAL_TOKEN`,
and browser-reachable transports use scoped signed tickets plus `RUNNER_ALLOWED_ORIGINS`. Coding
engines receive only short-lived capabilities bound to persisted session, Run, Attempt, lease, and
expiry. The runner re-derives Actor, workspace membership, and live execution authority from
Postgres; raw internal tokens, provider credentials, and client-asserted tenancy never enter a
sandbox.

Provider OAuth state, exchanges, and encrypted credential storage are API-owned. Historical web
callback URLs may be thin continuity relays, but they do not verify providers or persist credentials.
Never expose server credentials through `NEXT_PUBLIC_*` variables or client DTOs.
