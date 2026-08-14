# Brain engineering map

Brain is opencompany's workspace knowledge store: Markdown knowledge pages, immutable evidence,
file-backed documents, provenance, and a lightweight relation/wiki-link graph. Postgres is the
durable authority. Filesystem trees are temporary projections for runner ingestion agents, not the
storage model.

## Runtime ownership

- `apps/api` owns authenticated Brain commands, assets, sources, fixed read models, MCP delivery,
  authorization, and persistence composition.
- `apps/runner` owns durable ingestion/import, Google Drive sync, provider poll/flush work, and the
  agentic curation loop.
- `packages/agent` owns shared Brain tools, capture behavior, MCP registration, and asset
  behavior used by those composition roots.
- `packages/brain` owns document schemas, parsing, validation, retrieval helpers, CLI behavior,
  and the pointer/copy rule.
- `packages/db` owns Brain tables, repositories, read queries, projections, and materialization.
- `apps/web` renders Brain UI and calls typed `/v1` resources or named API read models. It does not
  read or write Brain tables.

The web `/mcp` and selected asset/provider URLs are continuity relays to API-owned handlers. They do
not host MCP tools, authorize Brain access, verify provider payloads, or persist Brain state.

## References

| Page | Purpose |
| --- | --- |
| [Data model](./data-model.md) | document kinds, entity types, statuses, folder and identifier grammar, binary assets, and tables |
| [Ingestion](./ingestion.md) | durable source-item/job admission and runner curation paths |
| [Tools and CLI](./tools-and-cli.md) | browser-independent Brain reads, captures, MCP, and ingestion-agent CLI use |
| [Pointer/copy contract](./pointer-copy-contract.md) | provenance and evidence rules for Brain writers |

## Code map

| Area | Source |
| --- | --- |
| Schemas, validators, and folder rules | `packages/brain/src/schema.ts`, `schemas.ts`, and `folders.ts` |
| Document parse/serialize and graph edges | `packages/brain/src/document.ts`, `frontmatter.ts`, `inline-links.ts`, and `edges.ts` |
| Pointer/copy prompt contract | `packages/brain/src/pointer-copy.ts` |
| Filesystem CLI | `packages/brain/src/cli/index.ts` |
| Shared Chat/MCP Brain tools and capture | `packages/agent/src/brain-cli.ts`, `brain-surface.ts`, `brain-capture.ts`, and `mcp-server.ts` |
| API composition | `apps/api/src/server.ts`, `app.ts`, and `brain-assets.ts` |
| Runner ingestion | `apps/runner/src/brain-ingest-worker.ts` and `brain-agent-ingest.ts` |
| Tables, materialization, and read plane | `packages/db/src/product-schema.ts`, `brain-files.ts`, and `brain-read.ts` |

## Invariants

- Every command, query, job, and tool call is pinned to one `brain_ref` and rechecks authorized
  access at its boundary.
- Programmatic writes enter through authenticated API commands or durable capture/ingestion work.
  Chat and MCP expose read operations plus capture-to-curation; they do not expose raw mutation CLI
  commands.
- Evidence under `evidence/` is immutable. Knowledge pages cite evidence or canonical source refs
  instead of copying mutable provider bodies.
- Promoting a page to `active` requires cited provenance in compiled truth.
- Worker notifications and internal wake routes reduce latency only. The durable job row, lease, and
  polling loop own correctness and recovery.
