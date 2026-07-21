# Codex Preview Browser and Repo Profile Research

Status: research notes and architecture recommendation.

Date: 2026-07-07

This document captures the research and reasoning around adding a cloud coding-session preview
browser to Goat when Codex is the coding engine. The concrete motivating case is this repo itself:
a coding run should be able to execute setup, start the Goat dev command, open the running app in a
browser, navigate it, take screenshots or recordings, and ask the human to take over only when auth
blocks progress.

The recommendation is to treat the preview browser as part of the coding runtime, not as a separate
QA add-on. Codex should own browser intent. The runner should own browser infrastructure, auth
handoff, artifact storage, policy, and lifecycle.

## Executive Summary

The use case is feasible.

The right v1 architecture has four pieces:

1. A repo-owned runtime profile, preferably `.opencompany.yaml`, that defines setup command, dev
   command, preview port, health check, app origin, auth behavior, and artifact policy.
2. A runner-managed Preview Browser subsystem, separate from generic web browsing tools, that starts
   a provider-backed browser session and exposes safe browser actions to the coding agent.
3. A stable preview gateway from the browser to the app running inside the Codex sandbox, so WorkOS
   and cookies see one consistent HTTPS origin instead of changing E2B public URLs.
4. Persistent browser contexts, with human Live View takeover only when the agent reaches auth,
   MFA, passkey, or another credential-entry boundary.

Cursor's public cloud-agent direction supports this shape. Cursor describes cloud agents as running
inside isolated development environments, using the software they build, producing artifacts such as
videos, screenshots, and logs, and allowing humans to control the remote desktop when needed. That is
the strongest external precedent for this feature: the browser is an agent tool, while takeover is an
escape hatch.

## Sources Reviewed

Primary sources and docs used:

- Cursor Cloud Agents overview: https://cursor.com/docs/cloud-agent
- Cursor Cloud Agent capabilities: https://cursor.com/docs/cloud-agent/capabilities
- Cursor Cloud Environment setup: https://cursor.com/docs/cloud-agent/setup
- Cursor "agents can now control their own computers" post, February 24, 2026:
  https://cursor.com/blog/agent-computer-use
- Browserbase Contexts:
  https://docs.browserbase.com/platform/browser/core-features/contexts
- Browserbase authentication guidance:
  https://docs.browserbase.com/platform/identity/authentication
- Playwright authentication docs:
  https://playwright.dev/docs/auth
- E2B restricted public access:
  https://e2b.dev/docs/network/restrict-public-access
- E2B sandbox persistence:
  https://e2b.dev/docs/sandbox/persistence
- E2B remote browser/public URL use case:
  https://e2b.dev/docs/use-cases/remote-browser
- Codex manual fetched with the local `openai-docs` skill helper.
- WorkOS AuthKit Next.js guidance from the local WorkOS skill.

Local repo files inspected:

- `apps/goat/docs/README.md`
- `packages/db/src/goat-schema.ts`
- `apps/runner/src/goat-codex.ts`
- `apps/runner/src/codex-session.ts`
- `apps/runner/src/codex-app-server.ts`
- `apps/runner/src/goat-browser-tools.ts`
- `apps/runner/e2b/codex/template.ts`
- `scripts/dev.mjs`
- `scripts/next-goat.mjs`
- `docs/getting-started.md`
- `docs/env-vars.md`
- `docs/auth.md`

## Current Repo State

Goat tasks already have a Codex engine path.

The harness spec in `packages/db/src/goat-schema.ts` currently supports:

- `engine: "opencompany" | "codex"`
- model, system prompt, tools, skills, result mode, and max model steps
- Codex-specific fields for repository, PR creation, reasoning effort, and goal mode

The runner's Goat Codex path lives in `apps/runner/src/goat-codex.ts`:

- creates or connects an E2B sandbox
- optionally clones a connected GitHub repo into `/home/user/opencompany-goat/codex`
- writes Codex auth into `/home/user/.opencompany-goat/codex-home/auth.json`
- runs Codex through `codex app-server`
- persists refreshed Codex auth
- collects diff/PR output
- kills the sandbox in a `finally`

This is currently a one-shot sandbox lifecycle. That is acceptable for text tasks, but it is not the
right lifecycle for interactive preview work because the dev server, browser session, auth state, and
artifacts all need a more explicit runtime model.

The regular web Codex session path in `apps/runner/src/codex-session.ts` is more mature for long
running coding sessions:

- persists sandbox id on the session row
- reuses Codex App Server across turns
- records runtime events
- uses the same App Server machinery as Goat

Goat should converge toward that model for coding-session lifecycle instead of keeping a special
single-run Codex path.

## Existing Browser Tooling

There is already a Goat browser tool implementation in `apps/runner/src/goat-browser-tools.ts`.

It wraps `agent-browser` and exposes:

- `browser_open`
- `browser_snapshot`
- `browser_click`
- `browser_fill`
- `browser_wait`
- `browser_read`
- `browser_get`
- `browser_find`
- `browser_scroll`
- `browser_screenshot`
- `browser_close`

It has a conservative action policy. It allows browser navigation and interaction, but denies risky
capabilities such as eval, download, upload, network, and state.

This is useful precedent, but it is not enough for Codex preview browser work:

- It is runner-side task tooling, not Codex-sandbox-local app preview tooling.
- It is designed for browsing public or normal web pages, not for app preview attached to a coding
  sandbox and dev server.
- It does not model a persistent authenticated preview context.
- It does not create first-class screenshots/videos/logs as coding-run artifacts.
- It does not solve the network path from a hosted browser to `localhost` inside an E2B sandbox.

The new feature should reuse its policy mindset, but not overload this generic browser tool surface.

## Concrete Goat Dev Flow

The repo's local Goat flow today is:

- root script: `bun run setup`
- root script: `bun run dev:goat`
- `dev:goat` runs `scripts/dev.mjs --app=goat --ui=tui --filter=@opencompany/goat --filter=@opencompany/runner`
- Goat defaults to internal port `3002`
- local Caddy exposes Goat at `https://localhost:3443` when available
- `scripts/dev.mjs` injects Goat WorkOS redirect variables and enables the runner Goat task worker
- `apps/goat/app/api/healthz/route.ts` provides a health endpoint

For cloud Codex preview work, this should become data rather than hardcoded product knowledge.

The default profile for this repo should express:

```yaml
version: 1

profiles:
  goat:
    setupCommand: bun run setup
    devCommand: OPENCOMPANY_NGROK_DISABLED=1 OPENCOMPANY_GOAT_HTTPS_DISABLED=1 bun run dev:goat
    workingDirectory: .
    preview:
      enabled: true
      port: 3002
      healthPath: /api/healthz
      startPath: /
      env:
        GOAT_NEXT_PUBLIC_APP_URL: $OPENCOMPANY_PREVIEW_ORIGIN
        GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: $OPENCOMPANY_PREVIEW_ORIGIN/auth/callback
      auth:
        mode: human-on-demand
        contextKey: goat-workos
      artifacts:
        screenshots: auto-and-agent
        video: final
```

The exact file name can be decided, but `.opencompany.yaml` is a good default because it is
product-owned, checked into the repo, easy for agents to read, and naturally extends beyond Goat.

## Why File-Based Repo Profiles

A Goat UI for profiles would be less appropriate as the v1 source of truth.

Reasons:

- The setup/dev/preview contract belongs to the repo, like `package.json`, `render.yaml`, or
  `.cursor/environment.json`.
- It needs to travel with branches and PRs.
- Coding agents should be able to inspect and modify it in code review.
- It should work for other projects, not only Goat.
- It avoids a hidden database setting that makes cloud runs differ from the checked-out repo.

The UI can later display the effective profile, validate it, and offer a guided editor, but the
durable contract should live in the repo.

This repo already uses the `yaml` package in runtime packages, including agent file parsing and
skill resolution. A YAML profile would fit existing conventions.

## Cursor Lessons

Cursor's public materials give strong architectural signals:

1. The agent environment is the unit of autonomy.
   Cursor emphasizes isolated VMs/cloud sandboxes so agents can run many tasks in parallel without
   competing with the developer's local machine.

2. Agents must be able to use the software they are changing.
   Cursor explicitly frames browser and desktop interaction as removing a ceiling on agent
   capability.

3. Artifacts are product output, not logs hidden in infrastructure.
   Cursor names videos, screenshots, and logs as artifacts developers can use to validate work.

4. Human takeover is part of the model.
   Their cloud agents can be controlled remotely so a human can test the modified software without
   checking out the branch locally.

5. Environment setup is first-class.
   Cursor docs reference cloud environment setup and repo/environment-specific configuration. The
   product shape is not "guess the dev command every time"; it is "define or derive an environment
   contract and reuse it."

The lesson for Goat is: do not make screenshots a narrow Playwright afterthought. Build a coding
runtime that contains a preview surface and artifact pipeline.

## Codex Surface Choice

Codex App Server is the right base integration.

Reasons:

- The repo already uses `codex app-server` for both normal Codex sessions and Goat Codex tasks.
- It supports long-running thread/session behavior.
- It lets the runner stream Codex runtime events and preserve session identity.
- It is the documented programmatic integration surface for embedding Codex behavior in another app.

`codex exec` is less suitable because it is optimized for noninteractive script-style runs. It would
make preview work look like a batch job and would fight against browser iteration, auth handoff, and
session continuity.

Codex's built-in in-app browser is also not the right primitive for this cloud use case. The Codex
manual describes Codex browser and Computer Use surfaces, but the cloud GOAT architecture needs:

- persistent WorkOS cookies across sessions
- human takeover during auth
- stable app preview origins
- screenshots/videos attached to Goat task artifacts
- runner-controlled policy and storage

Those are product/runtime concerns outside a generic Codex-local browser pane.

## Browser Provider Choice

Browserbase is the strongest v1 provider fit.

Reasons:

- It provides real Chromium sessions controlled through Playwright/CDP style APIs.
- Its Contexts feature is designed to persist cookies, localStorage, IndexedDB, and other auth state
  across browser sessions.
- Its authentication docs explicitly recommend manual login through Session Live View and reusing
  the saved context later.
- Live View provides the human takeover path without building a remote desktop stack from scratch.

Playwright alone can persist storage state, but it does not solve cloud Live View takeover,
provider-managed browser lifecycle, observability, or easy handoff UX.

Browserless is plausible, especially because existing Goat browser env names reference Browserless,
but the research points to Browserbase as a cleaner first implementation for persistent identity and
human-in-the-loop auth.

E2B can run browsers and expose ports, but the best v1 separation is:

- E2B owns coding compute and dev server.
- Browserbase owns preview browser and Live View.
- OpenCompany owns the gateway, policy, artifacts, and session records.

A later v2 could support E2B desktop or self-hosted remote desktops for full computer-use parity with
Cursor.

## Preview Gateway Requirement

The hardest non-obvious requirement is stable origin.

If Browserbase navigates directly to changing E2B public URLs, WorkOS and browser cookies will be
fragile:

- each sandbox URL can differ
- redirect URIs must match WorkOS configuration
- cookies are origin-scoped
- persisted contexts are much less useful if the origin changes every run

The preview browser should navigate to an OpenCompany-controlled HTTPS origin, for example:

```text
https://preview.opencompany.cloud/p/<preview-session-id>/
```

or a profile/project stable host such as:

```text
https://<profile-slug>.preview.opencompany.cloud/
```

The gateway maps that stable origin to the active sandbox port. It can use E2B restricted public URLs
and inject the per-sandbox traffic token server-side. The browser never needs to know the E2B token.

For WorkOS/AuthKit, the app should receive:

- `GOAT_NEXT_PUBLIC_APP_URL=$OPENCOMPANY_PREVIEW_ORIGIN`
- `GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI=$OPENCOMPANY_PREVIEW_ORIGIN/auth/callback`
- equivalent `NEXT_PUBLIC_*` variables when the app expects them

The gateway must route the callback to the same active preview session. A signed preview-session
cookie or path-bound routing token can bind the browser to the correct backend.

## Auth Model

The goal is not to automate credentials. The goal is to preserve an authenticated browser identity
after a human completes login once.

Recommended flow:

1. Runner starts a PreviewSession with a Browserbase context derived from:
   `{userWorkosId, repositoryFullName, profileName, preview.auth.contextKey}`.
2. Codex opens the preview URL through its preview browser tool.
3. If the app is already authenticated, Codex continues.
4. If the app redirects to WorkOS/AuthKit, Codex calls `auth-request`.
5. Runner pauses agent browser actions and emits a Goat event.
6. Goat UI shows a "Take over preview browser" action.
7. User opens Browserbase Live View and completes WorkOS, MFA, passkey, or magic-link flow.
8. User releases control.
9. Browserbase persists the context.
10. Codex resumes and navigates the authenticated app.

Important policy:

- Codex should not ask for or receive passwords, OTPs, passkeys, or magic links.
- Agent browser actions should be paused during human takeover.
- Recording during credential entry should be disabled or redacted unless there is an explicit
  product/security decision to keep it.
- Browser context ids and Live View URLs are credentials and must be treated like secrets.

This matches Browserbase's documented auth pattern and avoids trying to script WorkOS.

## Agent Control Surface

The user requirement is explicit: Codex should control the preview browser and decide where to
navigate, when to screenshot, and what to inspect. Human escalation only happens for auth blockers.

The clean abstraction is a runner-owned Preview Browser service exposed to the Codex session.

Preferred v1 shape:

- Add a small OpenCompany Preview MCP server or app-server-accessible tool bridge for Codex.
- Also install a CLI mirror, `opencompany-preview`, inside the sandbox for transparency and fallback.
- The MCP/CLI talks to a runner callback API using a short-lived preview token scoped to one
  PreviewSession.

Tool operations:

- `preview_open(urlOrPath)`
- `preview_snapshot()`
- `preview_screenshot(label?)`
- `preview_click(selectorOrRef)`
- `preview_fill(selectorOrRef, text)`
- `preview_wait(condition)`
- `preview_console()`
- `preview_network()`
- `preview_auth_request(reason)`
- `preview_current_url()`

The tool should not expose raw CDP or unconstrained eval. It should look more like the existing
Goat browser policy: enough interaction for app verification, with dangerous browser/system
operations denied.

The CLI mirror matters because Codex is naturally strong at terminal workflows. A visible command
such as this is easy for the model and humans to reason about:

```bash
opencompany-preview open /
opencompany-preview screenshot --label "goat-home-authenticated"
opencompany-preview snapshot
opencompany-preview auth-request "WorkOS login required"
```

However, the runner should still own artifact creation. The CLI should request artifacts from the
runner; it should not write screenshots only to the sandbox filesystem where the product might miss
them.

## Artifact Model

Screenshots and recordings should be first-class Goat task artifacts.

Recommended automatic captures:

- baseline screenshot after the dev server passes health check
- screenshot whenever Codex explicitly requests one
- final screenshot before task completion when preview is enabled
- final short video or trace if enabled by the profile
- bounded console and network logs for debugging UI failures

Artifact fields should include:

- task id
- preview session id
- artifact kind: screenshot, video, trace, console, network, log
- label
- route/current URL
- browser context key
- created by: agent, runner, human
- blob pathname or private artifact URL
- dimensions and mime type for images/video
- redaction or auth-sensitive flag when applicable

These artifacts should appear in:

- Goat task detail
- task event stream
- final task summary
- PR/check output when a PR is created

This is the Cursor lesson applied directly: artifacts are how the developer validates agent work.

## Repo Profile Schema

The profile should be general enough for non-Goat repos.

Proposed v1:

```yaml
version: 1

profiles:
  default:
    workingDirectory: .
    setupCommand: bun install
    devCommand: bun run dev
    env:
      NODE_ENV: development
    preview:
      enabled: true
      port: 3000
      healthPath: /
      startPath: /
      auth:
        mode: none
      artifacts:
        screenshots: auto-and-agent
        video: off
```

Profile fields:

- `version`: required, starts at `1`
- `profiles`: map of named profiles
- `workingDirectory`: relative path from repo root
- `setupCommand`: shell command run once before coding session starts
- `devCommand`: long-running shell command
- `env`: non-secret environment variables or variable references
- `preview.enabled`: whether to start preview infrastructure
- `preview.port`: sandbox port to expose
- `preview.healthPath`: path to poll through the preview gateway or inside sandbox
- `preview.startPath`: default path for Codex to open
- `preview.auth.mode`: `none`, `human-on-demand`, or future modes
- `preview.auth.contextKey`: stable suffix for browser context reuse
- `preview.artifacts.screenshots`: `off`, `agent-only`, `auto-and-agent`
- `preview.artifacts.video`: `off`, `final`, or future `always`

The runner should reject unsafe paths, missing command strings, invalid ports, and unknown profile
versions. It should not invent hidden behavior beyond documented defaults.

## Command Lifecycle

The runner should execute profile commands in this order:

1. Clone repository.
2. Read `.opencompany.yaml`.
3. Select profile from task input or default profile.
4. Validate profile.
5. Prepare environment variables, including `OPENCOMPANY_PREVIEW_ORIGIN`.
6. Run `setupCommand` in `workingDirectory`.
7. Start `devCommand` as a managed background process.
8. Wait for `preview.healthPath` on `preview.port`.
9. Start PreviewSession and browser.
10. Start or resume Codex App Server.
11. Instruct Codex that preview tools are available and expected for UI verification.
12. Capture final artifacts and stop/pause resources according to lifecycle policy.

Setup should be a separate phase from the Codex turn. Codex should not have to remember to run setup
before the dev command for standard sessions; the profile contract should do that.

## Database and Events

Likely new data concepts:

- repo profile parse/cache record
- coding runtime session
- preview session
- preview browser context
- preview artifact

This can be implemented either as Goat schema first or shared runner/web schema first. Because the
abstraction is meant to outlive Goat, the domain model should avoid names like `goat_preview_*`
unless there is a deliberate decision to keep the first implementation Goat-only.

New task/runtime event types should include:

- `profile.loaded`
- `profile.failed`
- `dev.setup.started`
- `dev.setup.completed`
- `dev.command.started`
- `dev.command.ready`
- `preview.started`
- `preview.auth_required`
- `preview.human_takeover_started`
- `preview.human_takeover_completed`
- `preview.artifact_created`
- `preview.failed`

The existing Goat event stream already supports task status and artifact creation. The new events
should integrate with that pattern rather than adding a parallel UI channel.

## Security Model

Security has to be designed in, not patched later.

Key risks:

- Browser context ids and Live View URLs are credentials.
- WorkOS cookies are user identity material.
- Sandbox preview apps may execute untrusted code from branches.
- The app may receive integration/dev secrets through env vars.
- Screenshots/videos may capture sensitive UI.
- A browser tool can accidentally navigate away from the intended preview app.

Recommended constraints:

- Use dev/preview WorkOS apps and redirect URIs.
- Do not copy local browser cookies into cloud.
- Store browser provider credentials server-side only.
- Scope preview tokens to one preview session and short TTL.
- Allow agent navigation only to the preview origin by default.
- Temporarily allow WorkOS/AuthKit domains only as part of auth flow.
- Pause agent actions during human takeover.
- Do not let Codex access raw browser storage state.
- Mark auth-adjacent recordings/screenshots as sensitive or disable them during takeover.
- Redact console/network logs for obvious secrets.
- Use E2B restricted public URLs with server-side token injection.

## Open Questions

Some decisions still need product/infra ownership:

- Should stable preview origins be per session path-based or per repo/profile host-based?
- Should Browserbase be mandatory for v1, or feature-flagged behind a provider interface from day
  one?
- Should video recording be on by default for all preview sessions, or only final/explicit?
- Should authenticated browser context reuse be per user and repo, or per user, repo, profile, and
  branch?
- Should Goat expose `.opencompany.yaml` validation errors in chat, task detail, or settings?
- How long should preview artifacts and browser contexts be retained?
- Should the agent be able to request human takeover for non-auth reasons, such as visual judgment?

The recommendation for v1:

- Browserbase is the only implemented provider, behind a small provider interface.
- Stable preview origin is path-based initially, because it is easier to route many sessions.
- Browser context reuse key is `{user, repository, profileName, auth.contextKey}`.
- Video is `final` only by default.
- Human takeover is allowed for auth only in v1.
- Artifacts follow the same retention policy as other Goat task artifacts.

## Why This Is Architecturally Sound

This design avoids glue code because it separates responsibilities cleanly:

- `.opencompany.yaml` owns repo-specific runtime knowledge.
- E2B owns isolated coding compute.
- Codex App Server owns coding-agent session execution.
- Preview Gateway owns stable network ingress to the app.
- Browserbase owns cloud browser, persistent context, and Live View.
- Runner owns policy, lifecycle, secrets, and artifacts.
- Goat UI owns task visibility and human takeover UX.

The result is reusable beyond Goat. Any repo can define a profile. Any engine that can call the
Preview Browser API can use the same preview session and artifacts. Codex is the first engine, not
the only possible one.

## Proposed Implementation Sequence

Phase 1: profile and command lifecycle.

- Add `.opencompany.yaml` parser/validator.
- Add profile selection to Goat Codex tasks.
- Run setup command, dev command, and health check before Codex turn.
- Keep screenshots out of scope for this phase except maybe a placeholder event.

Phase 2: preview gateway and provider.

- Add PreviewSession records.
- Expose sandbox port through a stable gateway URL.
- Add Browserbase provider integration with persistent contexts.
- Add Live View URL generation and secure storage.

Phase 3: Codex control surface.

- Add preview MCP/tool bridge or scoped CLI.
- Inject tool instructions into Codex App Server task prompt/config.
- Implement open/snapshot/screenshot/wait/auth-request first.
- Persist screenshots as task artifacts.

Phase 4: human auth takeover.

- Detect auth-required state through agent request and basic URL heuristics.
- Add Goat UI event and takeover action.
- Pause agent browser actions during takeover.
- Resume Codex after user releases control.
- Verify context reuse across a second session.

Phase 5: recordings and PR artifacts.

- Add final video/trace capture.
- Attach artifacts to task summary and PR/check output.
- Add console/network artifact capture with redaction.

## Test Plan

Unit tests:

- YAML profile parsing and validation
- default profile selection
- env interpolation
- command sequencing
- invalid profile errors
- browser action policy
- artifact event generation

Integration tests:

- clone repo, load profile, run setup command, start dev command
- wait for Goat `/api/healthz`
- open preview start path
- capture screenshot artifact through mocked Browserbase provider
- auth-request event appears when requested

Manual acceptance test:

- Start Goat Codex task for this repo with profile `goat`.
- Runner runs `bun run setup`.
- Runner runs `bun run dev:goat`.
- Codex opens the preview browser.
- Browser reaches WorkOS.
- Codex requests human takeover.
- User completes WorkOS in Live View.
- Codex resumes and screenshots authenticated Goat UI.
- A second task reuses the same browser context without requiring login again.

## Final Recommendation

Build this as a general coding runtime feature, not as a Goat-only screenshot script.

Use `.opencompany.yaml` for repo profiles. Use Codex App Server as the coding engine integration.
Use Browserbase for v1 preview browser, persistent contexts, and auth takeover. Put a stable
OpenCompany preview gateway between Browserbase and E2B. Expose preview browser control to Codex as a
first-class tool/CLI, and store screenshots/videos/logs as task artifacts.

This matches the direction Cursor is publicly taking, fits the current runner architecture, handles
WorkOS without unsafe credential automation, and gives us an abstraction that can support other dev
projects later.
