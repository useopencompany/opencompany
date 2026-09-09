# Personal and Company Skills

Status: accepted for PRO-235 (Skills only).

## Decision

Each standalone Skill has a `personal` or `company` scope and a creator. Creation and imports default to Personal when scope is not specified. The creator alone can discover, read, use, edit, disable, archive, or share a Personal Skill. Current workspace members can discover, read, use, edit, replace imported bundles, and enable/disable Company Skills. The creator and current admins can change Company visibility or archive it. Admin status does not grant access to another member's Personal Skills.

Visibility is a setting on the same installation. Changing it preserves its ID, content and creator. Returning a Company Skill to Personal returns it to its creator, including when an admin performs the change. No copy, publishing state, approval flow, transfer UI, or per-member sharing is introduced. Plugins retain their existing administration and shared access rules. Workflow ownership and run identity are deferred.

Settings has an All / Company / Personal filter for every member. New and Import start with the selected scope; All starts with Personal. The New button names the scope, and both dialogs let the member change it before submitting. API and agent creation still default to Personal when scope is omitted. Company collaborators see a locked visibility label with the management rule in a tooltip.

## Identity and authorization

Personal names are unique per creator in a workspace; Company names are unique per workspace. Archived installations do not reserve names. Lists, links, picker mentions and tools carry stable installation IDs. Legacy names remain valid when unambiguous. Ambiguous names and conflicting same-name selections fail explicitly.

Repository reads and mutations check current workspace membership and scope. Rights in API responses are calculated on the server. Scope changes use expected scope and edits use expected bundle IDs for conflict detection. Mutations lock the installation. Trusted shared Task tool contexts restrict access to Company Skills; workflow catalogs and immutable loading without an individual reader are also Company-only. Personal Skills can be used in their creator's private Chats.

Immutable bundle IDs are content addresses, not authorization. Installation-to-version grants record which revisions were shared with the company. Sharing the current revision does not expose earlier private drafts. A member's existing private Chat may still load the exact revision it already captured after visibility changes. A guessed bundle or Chat ID cannot obtain that exception; that snapshot exception requires the Chat owner and current membership. Shared execution requires current Company or Plugin access. Existing results and files already delivered are not erased by a scope change.

## Migration and deployment

Migration 0262 keeps all existing standalone Skills Company-scoped, including archived entries, because they were previously shared. It records their previously shared same-name immutable bundles as Company revisions. Existing creator IDs are unknown and remain null; current admins manage those Skills. The admin making a legacy Skill Personal becomes its creator. Newly created rows default to Personal and require a creator. Scoped partial unique indexes replace the old workspace/name index.

Apply the migration before serving the new API, web and runner code. Old application versions do not enforce Personal visibility; do not roll back to them after Personal Skills exist. A rollback requires restoring compatible authorization or explicitly resolving Personal data before returning to the old schema and code.

## Consequences

Small teams get one visible choice and collaborative Company editing. Imported sources retain their existing immutable-source editing restriction. Disabling and archiving stop new selection without rewriting past work. Existing private Chat snapshots explain why making an item Personal cannot revoke information already used. Workflow ownership and who runs a Workflow remain separate product decisions.
