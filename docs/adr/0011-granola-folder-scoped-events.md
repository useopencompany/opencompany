# ADR 0011: Granola Folder-Scoped Events

- Status: Accepted
- Date: 2026-09-13
- Extends: [ADR 0009](./0009-poll-delivered-plugin-events.md)

## Context

ADR 0009 shipped `meeting.notes_ready` with no filters and recorded folder scoping as out of
scope: a note's `folder_membership` names only each folder's direct parent, so it "cannot reproduce
the subfolder semantics of Granola's own webhook filter without fetching the folder tree."

An unfiltered event starts a run for every meeting Granola finishes summarising. For the teams we
build for that is most of the working day — 1:1s, standups, interviews — and the useful jobs are
scoped: draft the follow-up after a customer call, file the action items from an investor update.
Linear's `issue.created` already carries the optional team filter that makes the equivalent job
practical, and Granola folders are how these teams already separate those meetings.

## Decision

The Granola package declares one optional `integration_resource` filter, `folder`, resolved through
the same `<provider>:<resourceType>` loader registry Linear's team filter uses.

A folder filter covers the folder and its descendants, which is what `folder_id` means in Granola's
own note query and what its webhook filter offers. `GET /v1/folders` supplies `parent_folder_id`
for every folder, so the tree the earlier decision lacked is one paginated read. A poll pass takes
it once, and only when a route actually filters on a folder, then walks each of a note's
memberships up to its ancestors. A membership entry's own `parent_folder_id` is kept in that walk,
so a folder created between the list read and the note still reaches one level up.

A failed folder read ends the pass before the cursor advances, and a rejected key marks the
connection `needs_reauth` as any other Granola call does. Matching against a tree the platform
could not read would drop runs and then poll past the notes that should have started them.

This is the first filter whose delivery-side value is a set rather than a single id — a note can
sit in several folders — so `workflowEventFiltersMatch` accepts either and passes when the
configured id is among the values.

## Consequences

An author who sets no folder keeps the previous behavior exactly, so the filter is additive for
every existing subscription. Installations need the plugin update action to see it, the same as
Linear's team and status filters.

One extra Granola read per five-minute pass, per connection with a folder-filtered route. Granola's
limits are far above that, and an account with no folder filter is unchanged.

A folder read outage now delays Brain ingestion for that connection by one interval rather than
letting the pass complete, because the cursor is shared. That trade buys the guarantee that a
configured event either fires or visibly retries, and never silently skips.

Beyond 600 folders the listing reports itself partial. The editor says so; the poller still stops
the pass rather than matching on a tree it knows is incomplete.

Provider reference: [Granola list folders](https://docs.granola.ai/api-reference/list-folders).
