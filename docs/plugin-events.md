# Plugin events and workflows

A workflow keeps its manual, schedule, or event trigger and its existing step editor. To use an
event, install the official plugin, connect its event account in Plugins, and switch
on the event. In Workflows, choose **On an event → Plugin → Event**, select an account and any
filters, write the step instructions, and activate the workflow.

The initial supported events are:

| Plugin | Event | Configuration | Delivery |
| --- | --- | --- | --- |
| Linear | Issue created (`issue.created`) | Optional team and status category, including Triage | Signed webhook |
| Granola | Meeting notes ready (`meeting.notes_ready`) | Optional folder, including its subfolders | REST polling, normally within five minutes |
| Jamie | Meeting completed (`meeting.completed`) | Optional guests: outside your company, or internal only | Webhook you create in Jamie |
| Gmail | Email received (`email.received`) | Optional label | REST polling, normally within five minutes |

Linear's tool connection and event connection are separate. The event OAuth app must have Issue
webhooks enabled and point at the API-owned Linear webhook ingress. Its existing client, secret,
and webhook-signing configuration remain unchanged. Granola's MCP login cannot authorize REST
polling; save a Granola API key in the plugin's Events section. Saving a key does not enable an
event or create an ingestion source. Existing Linear installations show an update action to get
the new optional team and status filters, and existing Granola installations show one for the
optional folder filter.

Jamie has no webhook-management API, so its endpoint is created by hand. Create the endpoint in the
plugin's Events section, copy its URL, then create a webhook in Jamie's Settings → Integrations →
Webhooks against it, select `meeting.completed`, keep API Key authentication with the default
`x-jamie-api-key` header, and save the `sk_` key Jamie shows once back in that section. A personal
webhook covers your own meetings and a workspace webhook covers everyone's; that choice is made in
Jamie. Webhooks need a Jamie Plus plan or higher.

Each connection has its own endpoint URL, so a delivery is routed by the id in its path and its key
is then compared in constant time against the secret stored for that connection. An endpoint with
no key yet stays disconnected, and an event trigger only binds to a connected account. Jamie
exposes nothing that can validate a key on save, so the Events section reports when Jamie last
reached opencompany instead of claiming the key is good; Jamie's own Test button on the webhook
produces one immediately. Rotating the key in Jamie and saving the new one keeps the same
connection and the same URL, so workflows already bound to it keep firing.

Gmail has no plain webhook — push needs a GCP Pub/Sub topic and a per-mailbox `watch` renewal — so
`email.received` is delivered by the Gmail history poller. An account is polled while it has an
active event trigger, which since the Brain retirement is the poller's only consumer. The event binds to
the same personal Gmail connection the plugin page connects; there is no separate Events section.

The `label` filter offers the account's own labels, minus the ones that cannot describe an arriving
message: `DRAFT`, `SENT`, `SPAM`, `TRASH`, `CHAT`, and the two a person applies by hand afterwards
(`STARRED`, `UNREAD`). `INBOX` stays, because a Gmail filter that skips the inbox makes it a real
narrowing. This is the only filter Gmail declares on purpose: Gmail's own filter rules already
express "from anyone at acme.com" or "subject contains invoice" far better than an event filter
could, and a label turns any of those rules into a trigger condition without opencompany
re-implementing Gmail's matching.

`email.received` never fires on mail the mailbox sent, which is also what stops a workflow that
replies by email from re-triggering itself. Three bounds keep a mailbox's volume from becoming
agent tasks: the poller's existing noise floor, a 24-hour ceiling on message age so a trigger added
long after the account was connected cannot replay a backlog, and a cap of 25 messages per pass
that may start runs. Past that cap the remaining matches are dropped and logged rather than
deferred, because the history cursor has to advance for ingestion. The routed message is re-read in
full so the run's context carries the body; a body that cannot be read falls back to the snippet
rather than dropping the event. Email is the one event source anyone can write into, so its context
block states explicitly that the body is data and never instructions.

The `guests` filter is evaluated from the delivery itself: a meeting is `external` when anyone on
its calendar event or in its transcript has an email outside the recording user's domain. When the
payload does not name that domain, neither choice matches and only an unfiltered workflow runs.
Jamie's delivery id is not documented as stable across retries, so the duplicate key is derived
from the meeting's own identity — recording user, start time, and title — which makes Jamie's five
retry attempts and any re-processing idempotent.

Granola API keys require Business or Enterprise API access; Enterprise administrators may need to
enable key scopes for members. The poller requests only the note summary and metadata for workflow
events; full transcripts are no longer fetched, so an oversized transcript cannot block the event.
An event-only account is polled only while its owner has an enabled plugin event and an active
workflow in a workspace they still belong to.

## Company GitHub events

Company plugins are connected by an admin for the whole workspace (ADR 0018). Admins open
**Plugins → Company → GitHub** and connect any account where the GitHub App is installed and their
own GitHub account has access. In Workflows or a Company agent, choose **GitHub (company)**, an
event, the connected account, and a repository.

| Event | Configuration | Delivery |
| --- | --- | --- |
| Issue opened (`issue.opened`) | Required repository | Signed App webhook |
| Pull request opened (`pull_request.opened`) | Required repository, drafts included | Signed App webhook |

Repository options are the ones the trigger author's own GitHub account can access, and saving a
changed trigger re-checks that access. There is no per-member event toggle: linking the account is
the opt-in. Issues and pull requests opened by bots never start runs. Issue and pull request bodies
are written by whoever opened them, which on a public repository is anyone, so the run context marks
them as untrusted data.

**Pull request review** is the packaged setup for `pull_request.opened`: a workflow template that
asks for the account and repository, then opens a draft whose trigger is already bound to them and
whose step reviews the pull request and comments the findings. The clone needs a linked company
account; the run also needs the activating member's own **GitHub as you** connection, because a
company plugin delivers events but supplies no tools. Both gaps are named on the template card.

## Company-plugin implementation checklist

Use this when adding or changing a workspace-owned plugin. [ADR 0018](adr/0018-company-plugins.md)
owns the company/personal distinction. GitHub is the current implementation to trace; a company
connection supplies events, while actions still use the run owner's personal tool connections.
Paths below are repository-relative. Follow the rows that apply and account for each before review.

| Task | Files and completion criterion |
| --- | --- |
| Declare provider and events | `packages/core/src/company-plugins.ts`: register the trigger provider, integration provider, event IDs, and filters. Keep trigger names such as `github-app` distinct from connection names such as `github_app`. Export new declarations through `packages/core/src/index.ts`. |
| Persist workspace connections | `packages/db/src/company-github.ts` is the repository example; `packages/db/src/product-schema.ts` owns provider checks. Add a reviewed `drizzle/` migration for physical changes. Connections must remain scoped to the workspace through connect, disconnect, and provider removal. |
| Authenticate and authorize | `apps/api/src/auth.ts` resolves Actors. `apps/api/src/company-github.ts` enforces admin management and rechecks provider account access server-side. `validateCompanyGitHubTriggerAccess` rechecks the trigger author's repository access. Cover another workspace, non-admin management, and revoked access. |
| Expose typed commands | `packages/protocol/src/schemas.ts`, `packages/protocol/src/routes.ts`, and `packages/protocol/src/client.ts` own DTOs, route declarations/registration, and client typing. Include provider variants in trigger/resource schemas. Regenerate the OpenAPI artifact with the protocol package scripts. |
| Wire the API at runtime | `apps/api/src/app.ts` binds handlers and rate limits; `apps/api/src/server.ts` constructs repositories, connection services, and ingress. A route declaration alone does not wire the service. |
| Receive provider events | `packages/agent/src/integrations/github-app-events.ts` verifies signatures and normalizes bounded, untrusted context; `apps/api/src/github-app-ingress.ts` handles durable writes. `apps/web/app/api/webhooks/github/route.ts` is the thin relay example. Cover invalid signatures, duplicates, bot loops, uninstall/disconnect, and retryable persistence errors. |
| Resolve accounts and filters | `packages/agent/src/integration-resource-options.ts` loads authorized provider resources; `apps/web/lib/integration-resource-actions.ts` calls the API; `apps/web/lib/workflow-event-filters.ts` maps editor filter loaders. Return only resources the author can use. |
| Validate and route triggers | `apps/api/src/automations.ts` composes activation checks; `packages/db/src/workflow-event-subscriptions.ts` validates connected workspace accounts and declared filters; `packages/db/src/workflow-event-routes.ts` matches routes and enqueues idempotent event runs. Test activation cutoffs and workspace isolation. |
| Recheck queued work | `apps/runner/src/workflow-event-worker.ts` revalidates membership, workflow status, current connection, and unchanged trigger before task creation. Company declarations feed `companyPluginEventKeys`; test revocation after enqueue in `apps/runner/src/workflow-event-worker.integration.test.ts`. |
| Add settings and trigger UI | `apps/web/app/(app)/plugins/page.tsx`, `apps/web/app/(app)/plugins/company/github/page.tsx`, `apps/web/components/CompanyPluginSettings.tsx`, and `apps/web/lib/company-plugin-actions.ts` own company discovery/connection UI. `apps/web/lib/workflow-event-triggers.ts`, `apps/web/components/WorkflowEditor.tsx`, and `apps/web/components/CompanyAgentEditor.tsx` expose event choices. Cover disconnected and non-admin states. |
| Add a packaged workflow, when needed | `apps/web/lib/workflow-templates.ts` and `apps/web/components/WorkflowTemplatesButton.tsx` bind account/filter choices into a draft. Declare both the company event connection and required personal tool plugins so missing setup is visible before cloning. |
| Configure and verify | `.env.example`, [env ownership](env-vars.md), and `scripts/release-preflight.mjs` own deployment inputs. API ingress secrets belong to prod `/api`; add runner secrets only if the runner consumes them. Run the relevant provider/API/DB/worker suites, then the [CI checks](../CONTRIBUTING.md#local-checks). UI changes need real-product evidence. |

For SQL fixture failures, use the [fixture owner map](database.md#test-fixtures); these suites have
explicit migration lists or minimal DDL that must grow with the queries they exercise.

## Contract and ownership

Reviewed plugin packages declare `so.opencompany.events`. Each event has an ID, label, description,
delivery mode (`webhook` or `poll`), and filter definitions. Filters are either an
`integration_resource` resolved from the connected account, or a `choice` with declared `{id, name}`
options. The package parser validates declarations. The public protocol preserves them, the editor
renders them, and the database subscription validator rejects unknown filters or choice values.
New providers add their ingress or poll adapter and resource loaders to this same path.

Events default to off and are personal to the installed plugin's owner in the selected workspace.
Activation requires a connected personal event account and that user's enabled plugin event.
The router checks the same subscription when accepting a delivery. It writes an immutable execution
snapshot into the durable workflow event inbox. A unique `(workflow, provider, delivery)` key makes
provider retries idempotent. Provider context is bounded and separated from authored instructions.

The workflow stores its activation time in `workflows.event_activated_at`. Re-activation, switching
accounts, or changing routing filters starts a new activation interval; editing step instructions
keeps the interval. Events older than activation do not start runs. Granola initializes its cursor
on connection, retains pagination progress, and limits stale-note replay to 24 hours.

A Granola folder filter covers the chosen folder and its subfolders, the scope Granola's own note
query uses. A poll pass reads the account's folder list once, and only when a route filters on a
folder, so it can walk a note's direct memberships up to their ancestors. When that read fails the
pass stops without advancing the cursor and retries, because matching against a tree it could not
read would drop runs and then poll past the notes that should have started them. An account with
more folders than one listing reads is logged instead: retrying would never read more, so the pass
proceeds on each note's own membership entries rather than stopping that connection for good.

The runner checks current workflow status, membership, connection, plugin installation, and event
opt-in again before creating a task. Disabling the workflow or its event stops queued deliveries
when the worker next claims them. Work already executing follows the ordinary task cancellation
flow. Task creation and inbox settlement share a transaction; a savepoint rolls back partial task
writes after a database error so the worker can persist bounded retry/backoff. Task association
retains the workflow slug used by the existing task contract.

## Wiki ingestion retirement

Provider-to-Wiki routing, the Wiki ingestion worker, import writers, source settings, and their UI
entry points are removed. Old source/import HTTP endpoints return 410 and bookmarks redirect to
plugin settings.

Migration `0273_retire_wiki_ingestion` disables Wiki sources, marks queued/running Wiki jobs skipped,
and cancels unfinished Wiki imports. It retains Wiki pages, source records, and completed job
history. Constraints prevent an older API or runner from re-enabling Wiki sources or
queueing new Wiki jobs during a staggered release or application rollback.

An application rollback does not resume canceled ingestion. Restoring it would require an explicit
forward migration to remove the retirement constraints and a reviewed decision about replaying jobs;
never automatically replay the retired backlog. The normal release pipeline applies the migration
before deploying API/runner and then web.

## Verification

Focused UI tests cover plugin selection, optional filters, disconnected accounts, and retained
manual/schedule behavior. Signed Linear ingress tests cover retryable persistence errors. Jamie
ingress tests cover a missing key, an unknown endpoint, a wrong key, guest-filter matching, a
delivery id that survives a retry with a new delivery attempt, and the retryable persistence path. Postgres
integration tests cover activation cutoffs, duplicate deliveries, revoked subscriptions, transactional
rollback/backoff, and the retirement migration's retained pages and rejection of old producers.

Gmail label options and the poller's routing decisions are unit tested: the label picker's
exclusions and system-label names, the mailbox-scoped delivery key, the untrusted-content context
block, the widened poll-candidate query, sent-mail exclusion, label matching, the age ceiling, the
per-pass cap, and that an event-only account buffers nothing for ingestion.

Provider references: [Linear webhooks](https://linear.app/developers/webhooks),
[Granola list notes](https://docs.granola.ai/api-reference/list-notes),
[Jamie webhooks](https://docs.meetjamie.ai/developers/webhooks/getting-started),
[Granola list folders](https://docs.granola.ai/api-reference/list-folders),
[Gmail history list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list),
[Gmail labels list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list).
