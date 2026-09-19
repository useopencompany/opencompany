# Native Slack identities for company agents

Research snapshot: 19 September 2026. Status: **provisioning feasibility demonstrated;
workspace onboarding and automatic provisioning are proposed, not shipped**.

Runtime implementation: [PR #1957](https://github.com/useopencompany/opencompany/pull/1957).
Current runtime contract: [Slack channels](../slack-channels.md).

## Conclusion

One developer authorization per customer workspace can create and install independent native
Slack apps for company agents in that same workspace. We demonstrated this with both a
configuration token and a CLI service token. Each identity has its own app, bot user, credentials,
name, and avatar. OpenCompany still hosts agent execution and tool access.

The proposed beta flow is: an admin authorizes provisioning once; new active agents then receive
Slack identities automatically. Existing agents opt in individually. Customer-owned creation
avoids the public-distribution step required when installing centrally owned apps in other teams.
This does not remove Slack approval policies or establish commercial platform approval.

## Evidence and limits

Tests used dedicated Slack apps and an isolated OpenCompany development database. No production
migration or deployment was performed. Identifiers and credentials are intentionally excluded.

| Capability | Observation | Limit |
| --- | --- | --- |
| Native identity | Two independently installed agent apps had different app and bot user IDs. | One app per agent; a cosmetic sender override is insufficient. |
| Mentions and DMs | Both apps received signed events, started the correct agent tasks, and replied under their own bot IDs. DM thread follow-ups continued the existing task. | Public unshared channels and individual DMs; separate unmentioned channel-thread memory test remains outstanding. |
| Native profile | API rename propagated without changing the bot user ID; original name restored. A 512px icon update also propagated. | Not merely outgoing-message decoration. |
| Configuration grant | The same configuration token created and installed two independent apps in its own workspace, without new browser consent. | Tested authorizer was the primary owner. Refresh was not tested. |
| Service grant | User approved a generated Slack command, returned a challenge code, and the CLI exchanged it for a service token. | Earlier generic login errors occurred; exact cause unconfirmed. |
| Service provisioning | Direct HTTP requests created and installed an app in a second workspace, returning its bot token. Identity and all eight scopes were verified. | Authorizer was a workspace admin, not owner. This provisioning probe was not attached to the messaging runtime. |
| Ordinary bot token | Manifest creation returned `not_allowed_token_type`. | Connecting a normal bot does not grant provisioning authority. |
| Configuration scope request | Ordinary bot/user manifest scope lists rejected `app_configurations:read/write`. | Does not establish enrolled manager-app capabilities. |
| Cross-workspace creation | Passing another team ID with the configuration token still created the app in its original team. | The documented team argument has org-token semantics. |
| Automatic distribution | Creation with top-level `enable_distribution: true` succeeded; cross-workspace authorization later returned `invalid_team_for_non_distributed_app`. | Error reported by user; no OAuth callback captured. Callback URLs were updated between creation and authorization. Whether the flag was ignored, gated, or affected by updates was not isolated. |
| Manual distribution | Earlier apps installed into another workspace after manual activation. | Operational fallback, not automatic provisioning. |
| Managed apps | Managed permissions returned `feature_not_enabled`; manager scopes were unavailable in our ordinary setup. | Enrollment and plan coverage need Slack confirmation. |

The eight verified bot scopes were `app_mentions:read`, `chat:write`, `channels:read`,
`channels:history`, `users:read`, `users:read.email`, `im:history`, and `reactions:write`.
Do not infer permission to access every channel from these scopes.

## HTTP and CLI boundary

The official CLI uses ordinary HTTP for the authorization steps:

| Operation | Slack endpoint | Evidence |
| --- | --- | --- |
| Start service authorization | `apps.hosted.generateAuthTicket` | Direct form POST returned a ticket with CLI-compatible metadata. |
| Exchange approved challenge | `apps.hosted.exchangeAuthTicket` | Successful through CLI; source shows form POST. Direct successful exchange not separately tested. |
| Create identity | `apps.manifest.create` | Direct HTTP succeeded with the service token. |
| Install identity | `apps.developerInstall` | Direct HTTP succeeded and returned bot credentials. |
| Set name/configuration | `apps.manifest.update` | Native profile and configuration updates verified. |
| Set image | `apps.icon.set` | Native profile image readback verified. |

Ticket generation takes form fields `slack_cli_version` and `no_rotation=true`. Exchange takes
`ticket`, `challenge`, and `slack_cli_version`. Direct ticket requests with an application
User-Agent returned `internal_error`; keeping version `v4.8` and using the CLI-compatible
User-Agent succeeded. This is observed client-metadata sensitivity, not a documented contract.

Customers never need a CLI. Normal authenticated web routes can call a backend Slack adapter.
That adapter may initially retain a pinned CLI for the proven authorization exchange and use
HTTP for provisioning. Removing the binary is technically plausible; it does not resolve the
support status of these CLI-oriented endpoints. Do not advertise a fully verified native HTTP
onboarding flow until a direct challenge exchange is tested.

## Authorization and ownership

Configuration tokens belong to a user/workspace and can manage that user's apps in that
workspace. Access tokens expire after 12 hours; a refresh token returns a replacement pair.
Serialize refreshes and atomically persist both values. Only an access token was supplied for
our experiment, so refresh remains untested.

Slack documents service tokens as long-lived, non-rotatable user tokens intended for CLI
automation. They remain revocable and user-bound. No experiment established behavior when the
authorizing user leaves, changes role, or loses access.

Keep three authorities separate:

1. Workspace provisioning connection: creates/configures/installs agent apps.
2. Per-agent bot installation: receives events and replies as that identity.
3. Company-agent owner: authorizes the tools used while executing a run.

The new provisioning grant must not become an agent-accessible general-purpose tool. Match the
returned Slack team and authorizing user to the authenticated OpenCompany workspace setup.
Bind each app, bot, team, and agent explicitly. Do not accept arbitrary workspace IDs from the
browser or silently replace an existing connection with another team.

## Proposed web flow

Use the existing **Settings → Channels → Slack** location. Keep this workspace feature distinct
from a member's personal Slack plugin and preserve existing shared-bot workflow connections.

- An OpenCompany admin starts setup, runs a generated command in Slack, reviews Slack's own
  consent dialog, and enters its challenge code in OpenCompany.
- After exchange, show the actual workspace before confirming the connection. Default to
  automatically adding new active company agents to Slack; explain this before confirmation.
- Create identities when an agent is activated, not while an unsaved draft is edited.
- Existing agents remain opt-in, with owner-authorized **Enable Slack**.
- Mirror agent name/avatar, configure signed event ingress, verify identity and readiness, then
  expose **Open in Slack**. Never mark an accepted creation response alone as ready.
- Show setting-up, awaiting-approval, failed/retry, paused, and reconnect states accurately.
- Teammates invite an agent to a public unshared channel or open its DM. The current beta requires
  their Slack email to match an OpenCompany workspace member. Execution retains the owner's
  tool authority and existing approvals.

The screens are a proposal for review. Slack's own permission dialog should be depicted as a
provider-owned step, not as a consent modal we can redesign or bypass.

## Backend implementation outline

Workspace routes start authorization, complete it, report connection status, and reconnect.
Agent activation persists the agent first and enqueues a provisioning job with a unique
workspace/agent key. Provisioning should persist the Slack app ID as soon as known; retries
resume the same operation rather than blindly creating duplicates. Ambiguous creation timeouts
require reconciliation before a retry.

Store encrypted provisioning credentials separately from per-installation bot and signing
secrets. Keep tickets/challenges out of logs and bind a short-lived setup attempt to the current
admin session/workspace. The UI receives statuses and display metadata, not reusable tokens.

Reuse the existing dedicated ingress, durable inbox, event deduplication, agent-owned tasks,
thread subscriptions, and reply routing in PR #1957. Durable hosting replaces temporary tunnels.
A sandbox sleeping or a quick tunnel expiring is a test-host failure, not a Slack capability limit.

Reconnection must validate the same Slack team and reconcile existing apps without duplicating
identities. Pausing an agent should not uninstall it. Turning off provisioning for future agents
must be distinct from removing existing identities. Define and test disconnect semantics before
promising that existing bots survive revocation of the provisioning grant.

## Remaining gates

- Test direct HTTP challenge exchange if removing the CLI authorization adapter.
- Wire service provisioning into the product and prove creation → ready → mention/DM end to end.
- Verify per-app approval behavior in a controlled restricted workspace; do not change live
  customer workspace policy to test it.
- Test refresh if supporting configuration grants, service revocation, reconnect, loss of role,
  and departure of the authorizing user. Verify effects on existing bot tokens explicitly.
- Obtain Slack confirmation for hosted custody of developer/service credentials and commercial
  provisioning through these endpoints. Customer-owned custom apps connected to a paid service
  are not automatically exempt from commercial-distribution requirements.
- Verify creation limits, free-plan app capacity, and commercial history rate limits. Do not
  assume test throughput or customer ownership implies an exemption.
- Manager-app enrollment is an alternative path, not currently available to this integration.

## Primary sources

- [Configuration tokens and manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)
- [Token rotation](https://docs.slack.dev/reference/methods/tooling.tokens.rotate/)
- [CLI authorization and service tokens](https://docs.slack.dev/tools/slack-cli/guides/authorizing-the-slack-cli/)
- [Non-interactive authorization command](https://docs.slack.dev/tools/slack-cli/reference/commands/slack_auth_token/)
- [Authorization source](https://github.com/slackapi/slack-cli/blob/983461d37171039920b306f5253755e29f0312ac/internal/api/auth.go#L85)
- [CLI HTTP client](https://github.com/slackapi/slack-cli/blob/983461d37171039920b306f5253755e29f0312ac/internal/api/client.go#L101)
- [Developer installation source](https://github.com/slackapi/slack-cli/blob/983461d37171039920b306f5253755e29f0312ac/internal/api/app.go#L749)
- [Public distribution](https://docs.slack.dev/app-management/distribution/)
- [Manager permissions](https://docs.slack.dev/reference/methods/apps.managed.permissions.set/)
- [CLI approval errors](https://docs.slack.dev/tools/slack-cli/reference/errors/)
- [API commercial terms](https://slack.com/terms-of-service/api)
- [Free-workspace app limits](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces)
- [History rate limits](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
