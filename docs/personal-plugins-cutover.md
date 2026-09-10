# Personal plugin ownership and cutover (PRO-230)

Plugins belong to one member in one workspace. The member's installation controls its files,
skills, MCP approval, discovery cache, events, and saved plugin data. Members can install the
same package independently. An administrator does not gain access to another member's installation.
Shared Skills and Workflows can require a plugin; running them still requires the acting person's
installation and personal account. Durable plugin IDs are snapshots, not authorization grants.
Every runtime read and gateway dispatch checks current ownership and workspace membership. Saved-data leases also require the exact running installation and its current MCP approval, so a replacement with the same name cannot renew an older installation’s lease.

## Existing data and exceptions

Migration 0264 adds ownership without guessing who owns existing installations. Existing plugin
rows have a NULL owner and remain quarantined; existing saved-data archives and Infisical logins
have an empty legacy owner. No credential, private data archive, discovery snapshot, event setting,
or MCP approval is copied to a member. Each person installs their plugins and authorizes their own
accounts. Personal Infisical logins use both workspace and owner in credential encryption context.

| Existing path | Cutover behavior |
| --- | --- |
| Workspace plugin installations, pinned IDs, MCP approvals and discovery | Retained for audit; excluded from personal catalogs and all runtimes. Members reinstall and approve their own packages. |
| Workspace saved plugin data | Retained under the legacy owner, never restored or deleted by a personal installation. Reinstalled plugins start with empty personal data. |
| Workspace Infisical login | Retained but inaccessible. Each member performs a new login; old sandbox authentication is cleared during reconciliation. |
| Workspace Stripe restricted key | Retired from the action catalog, plugin UI, and new key setup API. Stripe MCP requires personal OAuth. An admin can still remove a legacy key; existing private credentials are not reassigned. |
| Generic workspace MCP OAuth fallback | Removed. Missing personal authorization requires reconnection. |
| Legacy built-in actions, including workspace Revolut | Removed from catalog fallback. Disabling/removing a plugin cannot revive an older integration route. Revolut needs a supported personal plugin before returning to the catalog. |
| GitHub App repository installations and Slack bot workspace installs | Remain infrastructure for repository access and bot ingress. They do not supply plugin action credentials; GitHub actions use `github_user`, Slack actions use the member's grant. |
| Existing personal provider OAuth accounts | Remain owned by the authorizing user in the credential vault. A workspace grants no access to them. The acting user's enabled installation authorizes use in that workspace. |
| Existing event workflows | Require the event owner's enabled personal installation and enabled event. Retired Linear triage subscriptions must be reconfigured to a declared plugin event. |
| Existing queued tasks and coding sessions | Old shared plugin IDs do not load. Users must install personal plugins and start new work to capture new IDs. Activated plugin Skills are also checked against current personal installation availability. |

Company knowledge permissions, repository authorization, bot ingress, subscription model accounts,
and paid capabilities are separate contracts. This change does not convert those into personal
plugin credentials or change their sharing rules.

## Deployment ordering

1. Apply migration 0264. `plugin_ownership_rollout.personal_enabled` starts false. New code rejects
   personal installation and Infisical writes until activation; this prevents older service revisions
   from seeing newly created personal rows as workspace data.
2. Deploy both API and runner with `personalPluginsAuthorization: v1` in health responses. New
   readers immediately exclude legacy shared installations. Some plugin operations are unavailable
   during this transition.
3. Deploy and smoke web. The release activation step checks web and both backend authorization capabilities, waits
   310 seconds beyond the runner shutdown window, checks again, then enables personal writes in a
   transaction. A failed backend deployment or missing capability keeps the gate closed.
4. Verify two members can independently install the same plugin and that removing one
   leaves the other's connection, discovery, Skills, events, and saved data intact.

Local `bun run setup` activates the same gate after migrations on the isolated development database.
Do not manually activate production while old API or runner instances are still serving traffic.
No production migration or direct production data mutation was performed during development.

## Rollback

Before personal writes are activated, the previous application can be restored while the gate stays
closed. The expanded schema and quarantined legacy rows are retained. Infisical writes from an old
binary must not be re-enabled against the new composite key; restore the pre-migration database
backup if that old login path is needed.

After activation, **do not roll back to a version that reads plugins by workspace alone**. It would
expose personal installations to teammates. Close personal writes and keep the ownership-enforcing
API and runner deployed while rolling forward a fix. A full rollback requires a maintenance window,
a pre-cutover database restore, and retirement of newly created personal data and sandbox caches.
That rollback loses post-cutover writes and requires explicit operational approval. Never merge
personal rows into the old workspace namespace or assign legacy archives to an inferred owner.
