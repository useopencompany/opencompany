# GitHub Local Development

Use this when testing the user-facing GitHub work integration from a local web app.

## Recommendation

Use a dedicated development GitHub App plus a stable ngrok domain.

GitHub App user authorization callback URLs can include more than one environment, but install
redirects and setup URLs are not a good fit for rapidly changing local URLs. A separate dev app keeps
production settings stable and prevents developers or parallel worktrees from fighting over a single
production app setting.

ngrok is part of the expected local developer experience for integrations that need a public callback
URL, especially GitHub and future webhook-backed integrations. Normal app development still works
without it, but end-to-end integration testing is much faster when ngrok is authenticated and using a
stable domain.

## GitHub App Settings

Create or copy a GitHub App for local development. Match the production app permissions and events.

**Repository permissions** the work integration App needs (grant these on both the dev and
production Apps; expanding scope on an existing App requires the org installation to re-approve):

- **Contents:** Read & write — clone, branch, commit, push.
- **Pull requests:** Read & write — open/update PRs.
- **Issues:** Read & write — `gh issue create` and the Issues API. Without this, those calls fail with
  `403 Resource not accessible by integration` (the runner surfaces an actionable hint, but the
  operation stays blocked until the grant + re-approval land).
- **Metadata:** Read-only (mandatory baseline).

For the current integration flow:

- Set **Setup URL** to `https://your-static-domain.ngrok.app/api/integrations/github/callback`.
- Enable **Redirect on update** if you want repository access changes to return to the local app.
- Add **Callback URL** `https://your-static-domain.ngrok.app/api/integrations/github/callback`.
- For opencompany local integration testing, add the equivalent opencompany callback URL for its public origin:
  `https://your-goat-static-domain.ngrok.app/api/integrations/github/callback`.
- Do not enable **Request user authorization (OAuth) during installation** for local development.
  The app callback receives `installation_id`, then the local app starts the OAuth flow with an
  explicit `redirect_uri`.
- Leave the GitHub App webhook inactive until the app has a webhook ingestion route. When it exists,
  use the same stable ngrok origin for the webhook URL and keep a webhook secret configured.

GitHub allows up to 10 callback URLs for a GitHub App, and the OAuth authorization URL can select
one with `redirect_uri`. The setup URL is separate: GitHub redirects there after installation and
includes an `installation_id`. Treat that id as untrusted until the local app verifies it with a user
access token, which is what `apps/web/lib/integrations/github.ts` does.

## WorkOS Settings

The local app must be opened on the same public origin that GitHub redirects back to, otherwise the
AuthKit session cookie will be on `localhost` while GitHub returns to the ngrok host.

Add this redirect URI to the WorkOS development environment:

```text
https://your-static-domain.ngrok.app/auth/callback
```

Keep `http://localhost:3000/auth/callback` too for normal local development.

## Local Flow

Run normal setup first:

```bash
bun install
bun run setup
```

Install and authenticate ngrok once, then reserve a static domain in the ngrok dashboard.

Start dev normally:

```bash
bun run dev
```

`bun run dev` starts ngrok first when the local ngrok CLI is authenticated, then starts the normal
Turbo dev stack with the public origin injected into the child process environment. It does not
change `.env.local`. If `OPENCOMPANY_NGROK_URL` / `NGROK_URL` is unset, the helper also accepts a
fixed `url`, `hostname`, or `domain` from the local ngrok config. When a fixed URL is configured,
ngrok is treated as required and `bun run dev` exits instead of silently starting without a tunnel.

To run only the tunnel:

```bash
OPENCOMPANY_NGROK_URL=https://your-static-domain.ngrok.app bun run github:tunnel
```

The tunnel helper writes these local values to `.env.local`:

- `NEXT_PUBLIC_APP_URL=https://your-static-domain.ngrok.app`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3000/auth/callback`
- `RUNNER_ALLOWED_ORIGINS` with the ngrok origin appended

When using `bun run github:tunnel` separately, restart `bun run dev` after starting the tunnel so
Next.js and the runner reload persisted env vars. Then open the app through the ngrok URL, sign in
through WorkOS with the localhost callback, and start the GitHub integration from
`/company/integrations`.

Set `OPENCOMPANY_NGROK_DISABLED=1` to skip ngrok for a dev session.

## opencompany Local Flow

`bun run setup` and `bun run env:pull` reuse the main app's existing
`GITHUB_INTEGRATION_APP_*` and `GITHUB_INTEGRATION_STATE_SECRET` values from Infisical. Setup also
mirrors those values into `apps/goat/.env.local` so direct app commands use the same GitHub App
credentials as the main app.

Run opencompany with the local runner and ngrok proxy:

```bash
bun run dev:goat
```

When ngrok is available, `dev:goat` injects the public ngrok origin as
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI`,
`NEXT_PUBLIC_APP_URL`, and `NEXT_PUBLIC_WORKOS_REDIRECT_URI` for that dev process. It also exposes
runner callback routes through the same public origin and sets `RUNNER_LLM_BROKER_PUBLIC_URL`.

Add these URLs to the development GitHub App and WorkOS environment for the ngrok domain you use:

```text
https://your-goat-static-domain.ngrok.app/api/integrations/github/callback
https://your-goat-static-domain.ngrok.app/auth/callback
```

If you prefer to run directly from Infisical instead of `.env.local`, use:

```bash
bun run infisical:dev:goat
```

## Worktrees

For parallel worktrees, keep the database isolation from `bun run setup` and use one of these tunnel
patterns:

- One active GitHub integration test at a time: share the same static ngrok domain and app, and point
  it at the worktree currently running on port `3000`.
- Concurrent GitHub integration tests: reserve a static ngrok domain per worktree, run each web app on
  a different `PORT`, and create one dev GitHub App per static domain.

Avoid dynamic ngrok URLs for this flow. Every new URL requires GitHub App and local env changes,
which removes most of the speed gained by the local setup scripts.

## Current ngrok Plan Expectations

ngrok's free plan includes one automatically assigned dev domain. That is enough for the local
GitHub flow as long as you add the assigned domain to GitHub. Free accounts cannot choose or
customize the domain name. Upgrade ngrok only if you need a specific branded ngrok domain, a
bring-your-own custom domain, or more domain capacity for concurrent worktrees.
