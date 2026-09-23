# ADR 0018: Company Plugins, Starting With GitHub

- Status: Accepted
- Date: 2026-09-23
- Extends: [ADR 0008](./0008-plugin-event-subscriptions.md)

## Context

Plugins became personal in PRO-230: each member installs a package and connects their own account.
Some integrations are not about a person. A GitHub organization emits issues and pull requests that
the whole company cares about, and a Company agent should be able to react to them without every
member wiring up the same thing.

## Decision

A company plugin belongs to the workspace. An admin connects it once and every member's company
automations can use it. Admins reach them through a Personal / Company switch on the Plugins page;
members keep the personal catalog.

Company plugins are platform-owned rather than installed from a package. Their connection is a
workspace-owned `goat.integrations` row, and their event vocabulary is declared in
`packages/core/src/company-plugins.ts` instead of a manifest. Tools, skills, and package updates
stay with personal plugins until a company plugin needs them.

The first one is GitHub (`github_app`). It reuses the GitHub App members already install for
"GitHub as you" instead of adding a second App:

- **Linking.** An admin picks an installation from the ones their own GitHub connection can reach.
  The API re-lists those installations server-side, so a browser cannot link an installation the
  admin cannot see. The row stores the installation id and account login, no credential.
- **Events.** Signed App webhooks arrive at `/api/webhooks/github`, relayed by web to the API,
  verified with `GITHUB_USER_APP_WEBHOOK_SECRET`, and mapped to `issue.opened` and
  `pull_request.opened`. Deliveries from bot senders are dropped so agents cannot trigger each other
  in a loop. Uninstalling the App disconnects every workspace row for that installation.
- **Triggers.** A trigger binds to the linked account and a required repository. Repository options
  come from the author's own GitHub connection, and saving re-checks that access whenever the
  author, account, or repository changes. Linking an organization therefore never exposes a private
  repository to a member who cannot open it on GitHub.
- **Runs.** Routing and the durable worker accept a company trigger while the workspace row is
  connected and the trigger is unchanged. There is no per-member plugin install or event opt-in to
  check. The run belongs to the member who activated the trigger; for a Company agent that is its
  owner, as for every other agent run.

## Consequences

Adding a company plugin means a declaration in `company-plugins.ts`, a workspace-owned connection
flow, and a provider ingress; the router, worker, and trigger editor are shared. The GitHub App needs
a webhook URL, a secret, and Issues and Pull request event subscriptions before events flow; the
variable is optional so a deployment without it degrades to a visible "not set up" state. Migration
`0310_company_github_app` only widens the integration provider check constraints, so an application
rollback leaves harmless unused rows behind.
