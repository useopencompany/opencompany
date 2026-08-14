# Chat browser sandbox

OpenCompany Chat can use a persistent, Conversation-keyed Vercel Sandbox for public-web browsing.
The runner invokes the browser capability through shared code in
`packages/goat-agent/src/browser-sandbox.ts` and `browser-tools-runtime.ts`; the web app only renders
the resulting semantic Events and screenshots.

The sandbox firewall allows public destinations while denying private, carrier-grade NAT,
link-local, and cloud-metadata ranges. Screenshots are copied to private Blob storage and served by
the authenticated API route `/v1/chat-screenshots/{conversationId}/{filename}`. Raw blob locators do
not enter the browser protocol.

## Runtime configuration

`GOAT_CHAT_SANDBOX_IMAGE` optionally selects a prebuilt image in the runner environment. When it is
absent, the shared sandbox provisioner starts a stock Node 24 image and installs the pinned
`agent-browser` package and Chromium on first use. The fallback is appropriate for local checks but
has a slower first browser operation.

The runtime that creates the sandbox must have valid Vercel Sandbox authentication. Keep those
credentials server-side and follow the current Vercel SDK authentication method for that host; do
not expose them to the browser or sandbox process.

## Build the optional image

The image build pins the same browser runtime used by the shared package:

```sh
export VERCEL_TEAM_SLUG=your-team
export VERCEL_PROJECT_SLUG=your-web-project
apps/web/sandbox-image/build-push.sh
```

Set `GOAT_CHAT_SANDBOX_IMAGE_REF` instead when supplying the complete registry image reference. Once
the image is ready, set its reference as `GOAT_CHAT_SANDBOX_IMAGE` in the runner environment and
redeploy the runner.

## Smoke test

Start a new OpenCompany Chat Conversation and ask it to open `https://example.com`, report the page
title, and take a screenshot. Confirm the tool result and screenshot render, then send a later
Message in the same Conversation and verify it resumes the named sandbox. Also verify a request to a
private or link-local address is denied.
