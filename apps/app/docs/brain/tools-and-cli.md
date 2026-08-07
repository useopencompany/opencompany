# Goat Brain Tools and CLI

Every surface that reads or writes a brain, and what each is allowed to do.

## The `goat-brain` CLI

`packages/goat-brain/src/cli/index.ts`, bundled for the runner's ingestion agents and for chat's
`goat_brain` tool. It operates on a filesystem root (`--root`, default `goat-brain`;
`GOAT_BRAIN_ROOT` pins it) — in production that root is a temp dir materialized from
`goat.brain_documents` and synced back after mutations. `--json` gives machine-readable output;
`goat-brain help <command>` prints per-command usage with examples.

### Read-only commands

| Command | Does |
| --- | --- |
| `help` | Global or per-command help. |
| `list` | List docs without retrieval or model calls (`--folder`, `--limit`, `--include-merged`). The `skills/` zone is omitted unless explicitly selected with `--folder skills` or a descendant. Use this for inventory, not wildcard queries. |
| `get <id>` | Read one doc (`--section all\|truth\|timeline\|frontmatter`). |
| `timeline <id>` | Dated evidence entries (`--since 30d`, `--limit`). |
| `query <text>` | Hybrid retrieval over curated pages by default: BM25 + optional embeddings, graph expansion (`--hops`, `--graph-direction out\|in\|both`), filters (`--folder`, `--kind`, `--since`, `--lexical-only`, `--include-invalid`, `--include-merged`), and continuation via `--offset`. Use `--kind evidence` only for an explicit raw-source lookup. The `skills/` zone is omitted unless explicitly selected with `--folder skills` or a descendant. `--since` accepts compact windows like `6h`/`2d` or natural windows like `last 6 hours`. Query output includes `pagination.hasMore` and `pagination.nextOffset`; repeat the same query with that offset to continue. No LLM calls in the ranking loop (see [retrieval-planes.md](./retrieval-planes.md)). |
| `folder list` | Folders in use. |
| `doctor` | Validation, link, folder-shape, and weak-provenance findings (`health.ts`). |

### Mutations

| Command | Does |
| --- | --- |
| `create` | New doc: `--type` (one of the [8 entity types](./data-model.md#entity-types-the-8-type-contract)), `--id`, `--title`, `--truth`/`--truth-stdin`; optional `--folder`, `--kind`, `--alias`, `--tag`, `--relation type:id`, `--source-ref`. |
| `ingest` | One-shot LLM planner from source text (`--text`/`--text-stdin`, required `--source-ref`, `--dry-run`). |
| `rewrite <id>` | Replace compiled truth. |
| `set <id>` | Update `--title`, `--type`, `--status`. Promoting to `--status active` requires the truth to cite valid provenance with `[[evidence:...]]` or `[[source:...]]`. |
| `timeline-add <id>` | Append a dated evidence entry (`--at`, `--body`, `--source-ref`, `--evidence-id`). `append-timeline` is a compatibility alias. |
| `append-evidence <subject-id>` | Create an immutable `ev-*` record in `evidence/` and link it to the subject (`--relation`, default `about`). |
| `alias <id>` | `--add`/`--remove` aliases. |
| `link <id>` | `--to <target> --as <relation>` / `--remove <target>` edges. |
| `merge --from <id> --into <id>` | Mark a doc merged into another. |
| `move <id> --folder <path>` | Move between folders. Evidence stays inside `evidence/`; pages stay outside. |
| `delete <id>` | `--dry-run` to preview, `--force` to delete. Chat should only ever `--dry-run`. |
| `folder create --path <p>` | Validate/create a free-form folder. |

## Chat tools (`apps/goat`)

| Tool | Where | Capability |
| --- | --- | --- |
| `goat_brain` | `apps/goat/lib/brain-cli.ts` + shared read surface in `apps/goat/lib/brain-surface.ts` | Reads (`query`/`get`/`timeline`/`list`) are served in-process by the [read plane](./retrieval-planes.md) (`@opencompany/db/brain-read`) — no materialization, no CLI spawn. Main chat exposes the same read-only command surface as MCP and does not expose write commands. |
| `save_to_brain` | `apps/goat/lib/brain-capture.ts` | Capture-only for all members with access to the active brain: instant draft page in `inbox/` + durable curation job. Canonical integration refs can be copied with content or hydrated in the runner from a ref + integration id. This is the intended chat write path. See [ingestion.md](./ingestion.md#2-explicit-captures-from-chat-or-mcp-agentic). |

## Runner ingestion agents

`apps/runner/src/goat-brain-agent-ingest.ts` runs an AI SDK tool loop whose single tool is the
bundled CLI, allow-listed per pipeline (query, create, append-evidence, link, move, merge, …).
System prompts embed `GOAT_BRAIN_POINTER_COPY_RULE`. Dispatch and leasing live in
`goat-brain-ingest-worker.ts` — see [ingestion.md](./ingestion.md).

## MCP connector (external agents)

`apps/goat/app/mcp/route.ts` exposes one user-level MCP server at `/mcp`, OAuth-authenticated via
WorkOS AuthKit. The token identifies the user; every tool call authorizes the addressed brain by
workspace/brain membership, so one connector spans all brains the user can access. Tool
registration lives in `apps/goat/lib/mcp-server.ts`. Current canonical tool surface: `goat_brain`,
the same read-only command surface used by main chat (`query`, `list`, `get`, `timeline`, `help`,
`doctor`); `save_to_brain`, the capture-only write path; plus `list_brains` and an optional `brain`
argument (id, or slug when unique; auto-selected when the user has exactly one brain). Compatibility
wrappers `query_brain` and `get_document` remain available for older clients and delegate through
the same tool runner. Reads are served by the read plane. `save_to_brain` requires workspace-admin
access and immediately creates a draft in `inbox/`, then queues the same durable curation pipeline
used by Goat chat. MCP clients do not receive raw document mutation tools.

### MCP setup and completion

The reusable setup guide lives at `/setup/mcp`. It gives Claude, ChatGPT, and Cursor equal
prominence, remembers the user's chosen client, defaults to the active brain, and generates a first
useful query from the user's display name, workspace, and selected brain. The permanent Settings →
Integrations entry links to the guide; MCP setup is not part of onboarding.

Setup completion is global per Goat user, not per workspace, brain, or client. The sidebar reminder
stays visible until the user completes one successful `query` command through MCP against any brain
they can access. `goat.brain_tool_runs` remains the audit source of truth: completion requires
`ok = true`, `action = 'query'`, and a `source_ref` beginning with `mcp:`. OAuth alone, failed calls,
other MCP commands, and Goat chat queries do not qualify. A successful query with no hits does
qualify because it proves the authenticated connector path works.

The first qualifying trace and the user's `mcp_setup_completed_at` update are written in one
transaction. The timestamp is only set while it is null, so later or concurrent calls cannot
replace the first committed completion. Migration `0122_goat_mcp_onboarding.sql` backfills the same
signal from the earliest qualifying historical tool run.

## Capability summary

| Consumer | Read | Write |
| --- | --- | --- |
| Runner ingestion agents | ✓ (CLI — needs read-your-writes against its job root) | ✓ (CLI, allow-listed) |
| Goat chat `goat_brain` | ✓ (read plane) | never |
| Goat chat `save_to_brain` | — | capture → curation job only (all members with active-brain access) |
| Cloud Codex `save_to_brain` | — | capture → curation job only against the Brain pinned to the Codex chat |
| External agents (MCP) | ✓ (read plane: `goat_brain`, plus compatibility `query_brain`/`get_document`) | capture → curation job only (`save_to_brain`, workspace admins) |
