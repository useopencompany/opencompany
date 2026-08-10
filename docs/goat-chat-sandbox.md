# Goat chat browser sandbox

Goat main chat can use a persistent, session-keyed Vercel Sandbox for rendered
public-web browsing. Browser tools are available to every default Goat chat;
runner task sandboxes and their browser provider are unchanged.
The sandbox firewall permits public domains while denying private and link-local
subnets, including cloud metadata addresses.

## Authentication

Vercel deployments receive Sandbox authentication through OIDC automatically.
For local development, link the web Vercel project and run `vercel env pull`;
the resulting `VERCEL_OIDC_TOKEN` lasts 12 hours. Outside Vercel, configure
`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.

The screenshot path uses the existing private `BLOB_READ_WRITE_TOKEN`. Images
are served through an authenticated Goat route and are never exposed as direct
Blob URLs.

## Build the custom image

The image pins the same `agent-browser` release as the runner and installs
Chromium at build time:

```sh
export VERCEL_TEAM_SLUG=your-team
export VERCEL_PROJECT_SLUG=your-goat-project
apps/web/sandbox-image/build-push.sh
```

For local VCR authentication, `vercel env pull` supplies
`VERCEL_OIDC_TOKEN`; the script uses it with Docker when present. You may
instead set `GOAT_CHAT_SANDBOX_IMAGE_REF` to the complete VCR image reference.

After the registry reports the image as ready, set the same reference as
`GOAT_CHAT_SANDBOX_IMAGE` in Infisical `prod` + `/goat`, sync it to the Goat
Vercel project, and verify Sandbox authentication and Blob storage.

If the image variable is absent, Goat creates a stock Node 24 sandbox and
installs `agent-browser` plus Chromium once in the sandbox's `onCreate` hook.
This fallback is useful for local and preview verification but has a much
slower first browser call.

## Smoke test

Start a new default Goat chat and ask:

1. `Open https://example.com and tell me the page title.`
2. `Take a screenshot.`

The first turn should show an open result with a compact snapshot. The second
should render the screenshot in the transcript. A later turn in the same chat
should resume the named sandbox.
