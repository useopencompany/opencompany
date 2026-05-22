# Auth

We use [WorkOS AuthKit](https://www.authkit.com) for session management and [`@workos-inc/authkit-nextjs`](https://www.npmjs.com/package/@workos-inc/authkit-nextjs) for the Next.js integration.

## The flow

1. `apps/web/proxy.ts` wraps the app with `authkitProxy`. Anything outside the public allowlist (`/`, `/signin`, `/signup`, auth routes, and docs) requires a session.
2. Unauthenticated user hits a gated route → redirected to WorkOS hosted UI.
3. After login, WorkOS redirects to `/auth/callback` → AuthKit sets the session cookie.
4. The first request to any page calls `getCurrentWorkspace()` in `apps/web/lib/auth.ts`, which upserts the user, default workspace, and owner membership into our Postgres.
5. Subsequent requests use the cached context via React `cache()`.

## Key helpers in `apps/web/lib/auth.ts`

- `getOptionalCurrentWorkspace()` — returns `null` if no session. Use on public-ish pages.
- `getCurrentWorkspace()` — calls `withAuth({ ensureSignedIn: true })`, redirects to sign-in if missing.
- `requireCurrentWorkspace()` — returns the current workspace or redirects unauthenticated users to `/signup`.

All three are React-`cache()`'d so calling them multiple times per request is free.

## Configuring WorkOS

In the WorkOS dashboard:

- **Redirects** must include `http://localhost:3000/auth/callback` for local dev and the production callback URL for deploys.
- If local development can run on different ports, add `http://localhost:*/auth/callback` as an allowed redirect URI too. Keep a concrete URI as the default.
- AuthKit's hosted sign-in screen is enabled by default — no extra config needed.

Vercel is the source of truth for shared Development env vars. Use `bun run env:pull` to merge the shared setup values into `.env.local`. Local setup then replaces `DATABASE_URL` with the current Neon branch connection string.

## Env vars

| Var | Purpose |
|---|---|
| `WORKOS_CLIENT_ID` | Public client identifier. |
| `WORKOS_API_KEY` | Secret server-side key. Never expose to the browser. |
| `WORKOS_COOKIE_PASSWORD` | Encrypts the session cookie. Must be 32+ chars. Rotate by changing this — invalidates all sessions. |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | Callback URL. Must match WorkOS dashboard exactly. |

## User and workspace identity

We mint our own IDs rather than storing raw WorkOS IDs as primary keys:

- `users.id` = `usr_<workos_id>`
- `workspaces.id` for the default workspace = `wks_<users.id>`

`users.workos_user_id` has a unique index so we can dedupe on upsert.

## Sign-out

`/auth/sign-out` clears the AuthKit cookie. The app row stays in Postgres — we don't delete user data on sign-out.

## Adding a protected route

Anything not in `apps/web/proxy.ts`'s `unauthenticatedPaths` is protected by default. In the page itself:

```ts
import { getCurrentWorkspace } from "@/lib/auth";

export default async function Page() {
  const { user, workspace } = await getCurrentWorkspace();
  // ...
}
```

Public routes currently include `/`, `/signin`, `/signup`, `/auth/callback`, `/auth/sign-in`, `/auth/sign-up`, `/docs`, and nested docs pages.
