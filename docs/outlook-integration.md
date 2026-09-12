# Outlook integration

The official `outlook` and `outlook-calendar` packages use our Microsoft Graph MCP servers.
The shared Microsoft OAuth layer lives in `packages/agent/src/integrations/microsoft-*`;
`apps/api/src/microsoft-ingress.ts` owns connection flow. Web relays the public callback URLs.
Account storage uses the existing encrypted personal OAuth vault and leased token refresh.
Migration `0270_outlook_integrations.sql` adds the two providers to the three vault constraints.
It does not rewrite account data. Reverting the constraint expansion requires disconnecting and
removing Outlook rows first; retaining the expanded constraints while reverting application code
is safe. The `outlook-calendar` provider id deliberately matches the hyphenated plugin name so the
first-party gateway can use one identifier across the catalog, vault, and MCP route. Production
migration execution belongs to the normal release process.

## Behavior

Each plugin has its own Microsoft consent and personal account selection. The newest connected
account powers its tools. Uninstalling a plugin removes its tools; disconnecting the account revokes
opencompany access. Gateway tickets authorize a single tool/capability and expire after a minute.
Mail attachment URLs bind the exact message and attachment, expire after five minutes, and recheck
the connection, active installation, and current permissions at download time.

Mail is drafts-only. Move/archive/trash returns the new message id. Trash uses Deleted Items,
with restoration available through move_message. Graph answers those writes, a categories PATCH,
and an event create/update with the whole resource, so message and event bodies are truncated on
the way out of a write exactly as they are on a read. Categorization replaces the message's category
names after reading existing values; account master category creation is outside this version.
File attachments are bounded to 20 MB; embedded items and reference attachments are unsupported.

Calendar event views expand recurring occurrences. Personal-account availability reads the selected
calendar view to completion; a truncated result never implies availability. Microsoft 365 users can
also query colleague/resource availability using get_schedule. Tools create timed events and change
individual events/occurrences; all-day creation, recurrence creation, and series-wide writes are not
supported. The body of an online meeting cannot be edited, because a Graph update replaces the whole
body and would drop the join details; every other field on those events still updates. Invitations,
updates, cancellations, and invite responses can notify attendees.

## Release validation

Configure and verify the app and hosted environments as described in [environment variables](./env-vars.md).
Before release, use dedicated work/school and personal Outlook test accounts to:

1. Install each pinned package through the product importer and connect each account type.
2. Confirm every discovered tool belongs to the reviewed group and defaults to `ask`.
3. Search/read a conversation; create a draft and confirm it was not sent; move, categorize, trash,
   and restore a test message using each returned id.
4. Follow `nextPageToken` to the second page of a `$search` result, of a `get_conversation`
   whose `$filter` spans more than one page, and of `list_attachments`. `assertPaginationUrl`
   requires Graph's `@odata.nextLink` to carry every base query parameter with an identical
   decoded value, so a server-side normalization of `$search` or `$filter` would surface here as
   "belongs to a different query". The mocked tests build the ideal nextLink themselves and
   cannot detect this.
5. Download a file attachment, reject a tampered/expired link, then disconnect and verify that
   previously issued MCP tickets and download links no longer work.
6. List recurring occurrences, check personal availability, and query Microsoft 365 colleague
   schedules (including a per-schedule error). Create, reschedule, respond to, and delete a test event.
7. Exercise expiry/refresh and refresh-token rotation, then revoke Microsoft consent and verify
   the connection asks for reauthorization.
8. With both plugins connected to the same Microsoft account, decode the `scp` claim of each
   connection's access token. Entra grants consent per resource, so a calendar token may carry
   `Mail.ReadWrite` even though the calendar flow never requests it; the refresh in
   `microsoft-access-token.ts` sends no `scope`, so it inherits whatever the grant holds. Tool
   surface stays separate either way, but confirm the real blast radius of a stored token and
   record it before the PR's "separate mail/calendar consent" claim ships.
9. Inspect catalog, installed row, and detail heading in light/dark mode and at 14/20/24 px.

The unit tests cover mocked Graph responses and real MCP transport handshakes. They do not replace
live account validation or Microsoft publisher verification.

## Microsoft references

- [Authorization code flow and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [List messages and pagination](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Attachment downloads](https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0)
- [Calendar views](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)
- [getSchedule account support](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0)
