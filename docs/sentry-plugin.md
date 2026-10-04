# Sentry company plugin

An authenticated workspace admin connects one hosted Sentry organization. US data uses
`https://us.sentry.io/api/0/`; EU data uses `https://de.sentry.io/api/0/`. Grant exchange,
verification, and JWT token refresh use the global control API at `https://sentry.io/api/0/`.
Self-hosted Sentry is outside this MVP.

## Integration configuration

Create a public integration in Sentry with installation verification enabled. Configure:

- Redirect URL: `https://opencompany.chat/integrations/sentry/setup`.
- Webhook URL: `https://opencompany.chat/api/webhooks/sentry`.
- Permissions: `org:read`, `project:read`, `event:read`, `event:write`, `member:read`, `team:read`.
- Webhook subscriptions: issue and issue-alert notifications. Installation notifications handle deletion.
- UI schema: [sentry-integration-schema.json](./sentry-integration-schema.json).

The redirect carries `installationId` and a one-time `code`. The authenticated admin confirms the
current workspace and region. The API exchanges the grant, discovers its single authorized
organization, encrypts credentials, and keeps the connection incomplete until the admin chooses
projects and saves settings. It commits the settings, then verifies installation with Sentry
without holding the connection row lock, so webhook ingress never waits on a Sentry request. A
disconnect that lands during verification wins. Installation ownership
persists across disconnection. A different workspace cannot claim it. Disconnect before changing
the workspace's organization. Historical Tasks remain available.

Set `SENTRY_APP_CLIENT_ID`, `SENTRY_APP_CLIENT_SECRET`, and `SENTRY_APP_SLUG` in Infisical `prod`
`/api` and `/runner`, with matching values. These are server secrets, never browser configuration.
The Render declarations and release preflight require them in both runtimes. Local setup mirrors
these values from the development environment. The existing integration encryption key and
refresh lease serialize credential rotation across workers. JWT refresh replaces installation
tokens before their eight-hour expiry. A rejected refresh marks the connection `needs_reauth`.

Do not deploy until the values have synced to the hosted API and runner. This change adds the
configuration contracts; it does not provision real app secrets or submit the integration.

## Events and admission

The company registry declares `issue.created`, `issue.regressed`, and `issue_alert.triggered`.
Creation accepts error issues only. Regression requires `unresolved` with substatus `regressed`;
manual reopening is ignored. Every trigger needs one selected project. Direct creation and
regression additionally accept priority, environment, and up to 16 unique exact tag pairs. All
conditions must match one occurrence. Priority means triage priority, not severity.

Creation uses the first occurrence and verifies its timestamp against `firstSeen`. An issue
created in staging does not later become a new production issue. Regression chooses the latest
listed occurrence at or before notification time. It represents the regression context rather
than an exact causal event. The receipt pins its ID before fetching details and stores the context
before routing, so retries use the same evidence. Missing context is an explicit unmatched outcome. Transient enrichment failures
retry up to eight attempts with bounded exponential delay.

The API verifies HMAC against the raw body and stores a durable receipt before returning 202.
It performs no event enrichment on ingress and does not write the connection row; the last receipt
time shown in settings is read from receipts. A dedicated runner worker claims receipts with
leases, enriches them, and routes them into the shared workflow event queue. A slow Sentry request
therefore delays only other Sentry receipts, never Task creation for any provider. Exact payload redeliveries deduplicate;
a later regression with new notification data remains eligible. Alert settings store both
workflow and trigger IDs in `destination`. Configuration and delivery require an active shared
workflow with an enabled alert trigger for the installation and selected project.

Task admission holds the connection row lock in the Task creation transaction. It rechecks
activation cutoff, workflow, membership, connection, trigger conditions, and project selection.
Pending or executing investigations for the same workflow and issue suppress overlapping runs.
The cooldown defaults to 30 minutes from the last started run; regression bypasses it. The
workspace cap defaults to 25 event-driven Tasks per UTC day. Manual and scheduled Tasks retain
normal billing. Disconnection records a durable revocation cutoff. Queued deliveries cannot create Tasks,
even if the same installation reconnects before the worker claims them.

Tasks receive bounded issue and occurrence data, the trigger reason, and summaries from the
latest three completed Tasks for that issue in the workspace. Everything shares the 10,000-character
Task goal limit. Routing caps the prompt and occurrence data at 7,500 characters, and prior
summaries with available PR links fill the remainder, up to 6,000 characters. A Task with no
previous results gets no history block. Agents must treat provider content and previous results as
data, never instructions.

## Gateway tools and scopes

Chat and all workflow engines use the common permission gateway, including Codex and Claude Code.
Read tools default to On. Issue updates default to Ask. Background Ask requests fail closed;
unattended writes require an admin to enable the capability or individual tool. Members can
approve an interactive request but cannot persist a shared standing permission.

| Capability | API family | Required scope |
| --- | --- | --- |
| Selected projects | Organization projects, project detail | `org:read`, `project:read` |
| Project assignees | Project members, project teams | `project:read` |
| Issues and occurrences | Organization issues and issue events | `event:read` |
| Releases and commits | Project releases and project release commits | `project:read` |
| Logs and spans | Explore organization events with dataset and explicit project | `org:read` |
| Traces | Organization trace retrieval | `org:read` |
| Assign, unassign, resolve, archive | Organization issue update | `event:write` |

Organization and credentials always come from the workspace connection. Issue lookups validate
project ownership before follow-up reads or writes. Queries use explicit selected project IDs,
post-filter results, and remove foreign projects recursively from traces. Responses bound page
sizes, data volume, and time ranges, provide pagination cursors and source URLs, and distinguish
empty results from missing permissions or unavailable telemetry. Archive is permanent
`ignored` with `archived_forever`; resolution uses `resolved`.

## Templates and product setup

All templates clone as drafts and require explicit activation. Failed initialization archives
the partial draft using the existing template flow.

- Investigate Sentry issues selects project and conditions, creates creation and regression
  triggers, and uses the normal workflow model. Findings include impact, evidence, likely cause,
  uncertainty, and next action.
- Propose a Sentry fix also selects Codex or Claude Code, repository, and base branch. Setup checks
  repository access and branch existence. The step stores the repository and base branch as typed
  data, and each run's prompt names them explicitly, whatever the instructions say. Activation
  checks the coding account, GitHub account, Contents write and Pull requests write permissions
  for any step with a repository. Switching the step to a non-coding model drops the repository. One coding step investigates, fixes, checks, and opens a draft PR
  only when the change is justified and verified.
- Daily Sentry review defaults to 09:00 in the selected timezone. It reviews unresolved issues
  active in the preceding 24 hours and recommends the top five. It performs no writes.

Templates have no Slack or Linear requirement and never change Sentry issue status automatically.
Connection settings show health, selected projects, last receipt, daily usage, and recent receipt
and workflow outcomes. Suppression reasons include conditions, unavailable context, active
investigation, cooldown, cap, revoked access, and disconnected account.

## Local verification and release

Focused tests use mocked Sentry HTTP responses and a PGlite database applying migration
`0314_sentry_public_integration`. They exercise encrypted binding, verification, refresh,
permissions, project restrictions, durable receipts, routing, suppression, and template setup.
PGlite serializes transactions on one connection, so these tests do not establish distributed
Postgres race behavior. Test against a branch-isolated Postgres database before launch.

Browser verification requires `bun run setup`, a working Docker engine for Electric, and the
running product through its Tailscale HTTPS preview. Capture connection, conditions, template,
and delivery outcome states there. No live Sentry installation, alert, coding PR, or review
submission has been exercised for this implementation, per the user's instruction.

Before publication, explicitly authorize a live end-to-end test, provision credentials, verify
hosted refresh and receipt latency, and submit the tested integration for Sentry review. General
availability depends on Sentry publication approval. Monitor structured
`opencompany.sentry_receipt_processed`, `opencompany.sentry_enrichment_failed`,
`opencompany.sentry_receipt_worker_failed`,
`opencompany.sentry_run_suppressed`, `opencompany.sentry_task_started`,
`opencompany.sentry_refresh_failed`, and `opencompany.sentry_catalog_failed` events, gateway
permission failures, and integration refresh failures. Inspect durable receipt and delivery
outcomes for backlogs. `sentry_task_started` includes receipt-to-Task latency after Task creation commits.

The migration adds provider values and three tables without dropping existing data. An application
rollback can leave these tables and disconnected Sentry rows in place. Do not tighten provider
constraints while Sentry rows exist or delete historical Task associations as a rollback shortcut.

Implementation follows [company plugins](./adr/0018-company-plugins.md) and Sentry's official
[public installation](https://docs.sentry.io/integrations/integration-platform/public-integration/),
[installation tokens](https://docs.sentry.io/integrations/integration-platform/installation/),
[webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/),
[issue semantics](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/),
[alert actions](https://docs.sentry.io/integrations/integration-platform/ui-components/alert-action/),
[form fields](https://docs.sentry.io/integrations/integration-platform/ui-components/form-field/),
[regional domains](https://docs.sentry.io/api/#choosing-the-right-api-base-domain), and
[permissions](https://docs.sentry.io/api/permissions/).
