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
| `list` | List docs without retrieval or model calls (`--folder`, `--limit`, `--include-merged`). Use this for inventory, not wildcard queries. |
| `get <id>` | Read one doc (`--section all\|truth\|timeline\|frontmatter`). |
| `timeline <id>` | Dated evidence entries (`--since 30d`, `--limit`). |
| `query <text>` | Hybrid retrieval: BM25 + optional embeddings/rerank, graph expansion (`--hops`, `--graph-direction out\|in\|both`), filters (`--folder`, `--since`, `--lexical-only`, `--include-invalid`, `--include-merged`). |
| `folder list` | Folders in use. |
| `doctor` | Validation, link, folder-shape, and weak-provenance findings (`health.ts`). |

### Mutations

| Command | Does |
| --- | --- |
| `create` | New doc: `--type` (one of the [8 entity types](./data-model.md#entity-types-the-8-type-contract)), `--id`, `--title`, `--truth`/`--truth-stdin`; optional `--folder`, `--kind`, `--alias`, `--tag`, `--relation type:id`, `--source-ref`. |
| `ingest` | One-shot LLM planner from source text (`--text`/`--text-stdin`, required `--source-ref`, `--dry-run`). |
| `rewrite <id>` | Replace compiled truth. |
| `set <id>` | Update `--title`, `--type`, `--status`. Promoting to `--status active` requires the truth to cite `[[evidence:...]]`. |
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
| `goat_brain` | `apps/goat/lib/brain-cli.ts` (schema in `chat-ui.ts`) | Full CLI access against a per-call materialized root. Reads and mutations today — the mutation surface predates the "writes are agent-mediated" rule and narrows once the [read plane](./retrieval-planes.md) lands. |
| `save_to_brain` | `apps/goat/lib/brain-capture.ts` | Capture-only: instant draft page in `inbox/` + durable curation job. This is the intended chat write path. See [ingestion.md](./ingestion.md#2-chat-captures-agentic). |

## Runner ingestion agents

`apps/runner/src/goat-brain-agent-ingest.ts` runs an AI SDK tool loop whose single tool is the
bundled CLI, allow-listed per pipeline (query, create, append-evidence, link, move, merge, …).
System prompts embed `GOAT_BRAIN_POINTER_COPY_RULE`. Dispatch and leasing live in
`goat-brain-ingest-worker.ts` — see [ingestion.md](./ingestion.md).

## MCP connector (external agents)

`apps/goat/app/api/mcp/[brainRef]/[transport]/route.ts` exposes a per-brain MCP server,
OAuth-authenticated via WorkOS AuthKit — the token's grant *is* the brain, so a token for brain A
cannot address brain B. Current tool surface: `query_brain` (read-only retrieval returning JSON
hits). External consumers never get write tools; external content enters via ingestion jobs only.

## Capability summary

| Consumer | Read | Write |
| --- | --- | --- |
| Runner ingestion agents | ✓ (CLI) | ✓ (CLI, allow-listed) |
| Goat chat `goat_brain` | ✓ (CLI) | ✓ today, narrowing to capture-only |
| Goat chat `save_to_brain` | — | capture → curation job only |
| External agents (MCP) | ✓ (`query_brain`) | never |
