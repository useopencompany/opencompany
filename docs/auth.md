# Authentication

opencompany uses WorkOS AuthKit for browser and mobile sessions. `apps/web/lib/workos.ts` owns the
canonical browser app URL and redirect URI. The web sign-in/callback/sign-out routes and `activateWorkspace` are
permanent browser-shell responsibilities: they handle framework redirects, SSO/MFA flows, AuthKit
session re-sealing, and presentation cookies.

Product identity belongs to the canonical API. `GET /v1/identity` resolves the verified WorkOS
identity, performs bounded membership adoption, and returns the credential-free user/workspace view.
`POST /v1/identity/sync` owns user synchronization and authentication completion. The API performs
all associated persistence reads and writes; web does not import the database.

An org-less AuthKit mobile session bearer can bootstrap through `GET /v1/identity`. A missing local
user is synchronized as usual, and `user.onboardedAt` remains the readiness contract: `null` means
the user must complete web onboarding later; a non-null value with no workspaces is the normal
no-workspace state. Org-less bearer responses list accessible workspaces but deliberately return no
active workspace, active Brain, or Brains. `POST /v1/workspaces/{workspaceId}/switch` authorizes an
onboarded user's selection and returns the workspace's WorkOS organization ID so a mobile client can
refresh into an org-bound session.

`apps/web/lib/auth.ts` remains the Server Component resolver used throughout the UI. It calls the
identity resource under React `cache()`, preserving one request-scoped resolution and the existing
consumer semantics without creating another identity backend.

Local development uses `OPENCOMPANY_NEXT_PUBLIC_APP_URL=https://localhost:3443` and
`OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://localhost:3443/auth/callback` by default. Production
values live in Infisical `prod` `/web` and must match the WorkOS dashboard exactly.

## Browser/API session boundary

Production scopes the encrypted WorkOS session cookie to
`WORKOS_COOKIE_DOMAIN=opencompany.chat` so both web and API hosts receive it. A same-origin web
bootstrap migrates an existing host-only session before the first direct API request, and sign-out
clears both cookie scopes.

Every `/v1` route authenticates its caller. Most routes require a fully resolved Actor and workspace.
Identity, onboarding, and workspace selection use a narrower verified-identity tier because an
onboarded Actor may not exist yet; they do not accept client-supplied user authority. Workspace
selection checks the verified WorkOS user against the local onboarded account and accessible
workspace list before ensuring the workspace's WorkOS organization.

`API_BROWSER_ORIGINS` controls credentialed CORS. Unsafe cookie-authenticated requests additionally
require an exact allowed `Origin`; bearer-authenticated clients retain their token contract.
Authentication completion forwards the newly sealed browser session and the trusted web origin to
`POST /v1/identity/sync`.

The canonical API has three credential profiles:

- Browser cookies are sealed and refreshed through the primary `WORKOS_CLIENT_ID`; only this profile
  reads the active-workspace and active-Brain preference cookies.
- AuthKit session bearers from the dedicated `WORKOS_MOBILE_CLIENT_ID` verify against WorkOS's fixed
  per-client session JWKS and require signed `sub`, `sid`, and matching `client_id` claims. They may be
  org-less only on verified-identity routes; Actor-tier routes require `org_id`.
- WorkOS Connect resource bearers retain exact `OPENCOMPANY_AUTHKIT_DOMAIN` issuer and
  `OPENCOMPANY_API_OAUTH_AUDIENCE` validation. They also require `org_id` before Actor resolution.

Any `Authorization` header is authoritative and fails closed; an invalid bearer never falls back to
a browser cookie. AuthKit browser access tokens are not Connect OAuth API bearer tokens.

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
