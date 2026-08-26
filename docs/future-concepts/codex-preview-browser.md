# Coding-session preview browser

- Status: Proposed
- Original research: 2026-07-07
- Last reviewed: 2026-08-26

## Goal

Let a cloud coding session set up a repository, start its development server, use the application in
a browser, capture review artifacts, and request human takeover only at an authentication or other
credential boundary.

The browser should be part of the coding runtime rather than a separate QA job. The coding agent
owns browser intent; the runner owns browser infrastructure, network policy, authentication handoff,
artifact storage, and lifecycle.

## Proposed architecture

1. A repository-owned profile, tentatively `.opencompany.yaml`, declares setup and development
   commands, working directory, preview port, health path, start path, environment interpolation,
   authentication mode, and artifact policy.
2. A runner-managed preview subsystem connects one coding sandbox to a provider-backed browser.
3. A stable HTTPS preview gateway fronts the sandbox port so cookies and OAuth redirect URIs do not
   depend on changing provider URLs.
4. A persistent browser context retains authentication. A short-lived Live View capability allows
   human takeover for authentication while agent actions are paused.
5. Screenshots, final recordings, console summaries, and relevant logs become first-class Task or
   Conversation artifacts with sensitivity and retention metadata.

Codex App Server remains the first engine integration because it already owns long-running coding
sessions and streamed runtime events. The preview contract should remain engine-neutral.

## Repository profile sketch

```yaml
version: 1
profiles:
  opencompany:
    setupCommand: bun run setup
    devCommand: OPENCOMPANY_NGROK_DISABLED=1 HTTPS_DISABLED=1 bun run dev:web
    workingDirectory: .
    preview:
      port: 3002
      healthPath: /api/healthz
      startPath: /
      auth:
        mode: human-on-demand
        contextKey: opencompany-workos
      artifacts:
        screenshots: auto-and-agent
        video: final
```

The profile belongs in the repository so it travels with branches, can be code-reviewed, and can be
used by other projects without hidden database configuration. A product UI may later validate or
display the effective profile.

## Security constraints

- Use development OAuth applications and redirect URIs; do not copy local browser cookies.
- Treat browser context IDs, gateway tokens, and Live View URLs as short-lived credentials.
- Allow agent navigation only to the preview origin and explicitly required authentication domains.
- Pause agent actions during human takeover and keep raw browser storage inaccessible to the agent.
- Disable or mark captures as sensitive around authentication and redact credential-shaped log data.
- Restrict sandbox ingress and inject gateway authorization server-side.
- Keep browser-provider credentials in the runner only.

## Initial sequence

1. Parse and validate the repository profile; run setup, development, and health-check commands.
2. Add preview-session state, stable gateway ingress, and one browser provider behind a narrow
   interface.
3. Expose open, snapshot, screenshot, wait, and authentication-request actions to Codex.
4. Add human authentication takeover with agent pause/resume and context reuse.
5. Attach final artifacts to the durable result and review workflow.

## Open decisions

- Path-based per-session origins versus dedicated hosts.
- Browser context reuse scope and retention.
- Whether recordings are final-only or opt-in.
- The provider for the first implementation and the portability boundary around it.
- Which non-authentication situations, if any, should permit human takeover.

Implementation should not begin until the preview-origin and credential-boundary owners approve the
network and authentication model.
