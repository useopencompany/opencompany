# Auth

We use [WorkOS AuthKit](https://www.authkit.com) for session management and [`@workos-inc/authkit-nextjs`](https://www.npmjs.com/package/@workos-inc/authkit-nextjs) for the Next.js integration.

## The flow

1. `apps/web/proxy.ts` uses AuthKit's composable `authkit()` flow and returns through `handleAuthkitHeaders()`. Anything outside the public allowlist (`/`, `/signin`, `/signup`, auth routes, and docs) requires a session.
2. Unauthenticated user hits a gated route → redirected to WorkOS hosted UI.
3. After login, WorkOS redirects to `/auth/callback` → AuthKit sets the session cookie.
4. The callback syncs the WorkOS user and Organization into Postgres. If WorkOS did not return an Organization, the app invisibly creates the user's default Organization and refreshes the session into it.
5. The first request to any page calls `currentWorkspace()` in `apps/web/lib/auth.ts`, which requires `session.organizationId` and resolves the app workspace by `workspaces.workos_organization_id`.
6. Subsequent requests use the cached context via React `cache()`.

## The `currentWorkspace()` helper in `apps/web/lib/auth.ts`

A single function with options:

- `currentWorkspace()` — returns the workspace, or redirects unauthenticated users to `/signup`.
- `currentWorkspace({ optional: true })` — returns `null` if no session. Use on public-ish pages.
- `currentWorkspace({ skipOnboarding: true })` — same as above but does not enforce the onboarding redirect. Combine with `optional` as needed.
- `currentWorkspace({ requireAdmin: true })` — throws if the caller isn't a workspace admin.

The underlying session/workspace lookup is React-`cache()`'d, so calling `currentWorkspace()` multiple times per request only hits the DB once.

## Configuring WorkOS

In the WorkOS dashboard:

- **Redirects** must include `http://localhost:3000/auth/callback` for local dev and the production callback URL for deploys.
- If local development can run on different ports, add `http://localhost:*/auth/callback` as an allowed redirect URI too. Keep a concrete URI as the default.
- Local requests to `localhost` or `127.0.0.1` derive the AuthKit redirect URI from the request origin and normalize it to `http://localhost:<port>/auth/callback`. This keeps normal local sign-in/sign-up on localhost even when `NEXT_PUBLIC_WORKOS_REDIRECT_URI` is set to an ngrok URL for integration testing.
- AuthKit's hosted sign-in screen is enabled by default — no extra config needed.

Infisical is the source of truth for shared development env vars. Use `bun run env:pull` to merge
the shared setup values into `.env.local`. Local setup then replaces `DATABASE_URL` with the current
Neon branch connection string.

## Env vars

| Var | Purpose |
|---|---|
| `WORKOS_CLIENT_ID` | Public client identifier. |
| `WORKOS_API_KEY` | Secret server-side key. Never expose to the browser. |
| `WORKOS_COOKIE_PASSWORD` | Encrypts the session cookie. Must be 32+ chars. Rotate by changing this — invalidates all sessions. |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | Callback URL. Must match WorkOS dashboard exactly. |

## User and workspace identity

WorkOS Organizations are the source of truth for organization identity, membership, and future org-scoped auth features. App workspaces remain the internal tenant boundary:

- `users.id` = `usr_<workos_id>`
- `workspaces.id` = internal app id (`wks_<uuid>`)
- `workspaces.workos_organization_id` = matching WorkOS `org_...` id

`users.workos_user_id` has a unique index so we can dedupe on upsert.
`workspaces.workos_organization_id` has a unique index so one WorkOS Organization maps to one app workspace.

New sign-ups currently get one invisible default WorkOS Organization. Multi-workspace creation, organization switching, invitations, and member management are intentionally not exposed yet.

## Sign-out

`/auth/sign-out` clears the AuthKit cookie. The app row stays in Postgres — we don't delete user data on sign-out.

## Adding a protected route

Anything not in `apps/web/proxy.ts`'s `unauthenticatedPaths` is protected by default. In the page itself:

```ts
import { currentWorkspace } from "@/lib/auth";

export default async function Page() {
  const { user, workspace } = await currentWorkspace();
  // ...
}
```

Public routes currently include `/`, `/signin`, `/signup`, `/auth/callback`, `/auth/sign-in`, `/auth/sign-up`, `/docs`, and nested docs pages.
