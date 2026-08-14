# Brain tools and CLI

Brain has three tool surfaces with different trust and persistence boundaries. They share schemas and
retrieval behavior, but they are not hosted by the web app.

## Shared read surface

`packages/goat-agent/src/brain-surface.ts` defines the read-only command contract used by Chat and
MCP. `packages/goat-agent/src/brain-cli.ts` authorizes a Brain, records tool traces, and routes
indexed reads to `packages/db/src/goat-brain-read.ts`. Search, list, point reads, and timelines do not
materialize the whole Brain or spawn the filesystem CLI.

The read surface supports `query`, `list`, `get`, and `timeline`, with bounded filters and pagination.
`help` and integrity-oriented commands that genuinely require a corpus may still use a temporary
materialized root. Public callers cannot request a table, predicate, filesystem path, or database
credential.

## OpenCompany Chat

The runner composes Brain reads and `save_to_brain` into the OpenCompany engine through shared
`packages/goat-agent` application services. Reads are available for the Brain or Brains authorized
for the Conversation. A save creates an immediate draft plus a durable curation job; it does not
give the model arbitrary document mutation commands.

Codex uses a runner-owned Brain read tool and a persisted capture tool scoped to the Conversation.
The sandbox receives only tool results and short-lived capability context, never the database or a
Brain-wide write credential.

## MCP

`apps/api` hosts the authenticated MCP endpoint at `/mcp` using
`packages/goat-agent/src/mcp-http.ts` and `mcp-server.ts`. The web `/mcp` route is a stable relay.

The everyday MCP surface is:

- `list_brains`;
- `search_brain`;
- `get_document`;
- `list_documents`;
- `get_timeline`;
- `save_to_brain` for workspace admins;
- `goat_brain` as the advanced read-only command shape.

Every call resolves the verified user, selects an accessible Brain by opaque ID or unambiguous slug,
and authorizes it again. Read tools are available to Brain members. Capture preserves the
workspace-admin write boundary and enters the same durable curation path as Chat.

The reusable user setup flow lives at `/setup/mcp`. Completion is derived from the first successful
MCP Brain query, recorded transactionally in `goat.brain_tool_runs` and the user's setup timestamp;
OAuth alone does not mark setup complete.

## Filesystem CLI

`packages/goat-brain/src/cli/index.ts` operates on a filesystem root. It is used by runner ingestion
agents that need read-your-own-writes before a job syncs, and by explicit local/offline work. In
production the runner materializes one authorized Brain into a temporary directory and syncs only
validated changes back.

Read commands include `list`, `get`, `timeline`, `query`, folder inspection, and `doctor`. Mutation
commands include document create/rewrite/status, timeline and evidence append, aliases, links,
merge, move, folder creation, and delete. Each ingestion profile allowlists only the commands it
needs. Chat and MCP do not expose this mutation set.

## Capability summary

| Consumer | Read path | Write path |
| --- | --- | --- |
| OpenCompany Chat | runner-composed shared read surface | capture, then durable curation |
| Codex | runner tools scoped to the Conversation | persisted capture capability when a Brain is pinned |
| External MCP client | API-hosted shared read surface | admin-only capture, then durable curation |
| Runner ingestion agent | temporary filesystem CLI | allowlisted CLI mutations synced at job completion |
