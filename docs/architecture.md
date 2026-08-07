# Architecture

The orientation map for the opencompany platform. Source files are the source of truth; this page
exists so an agent or teammate can rebuild context quickly.

## The shape

opencompany is a headless product core with thin surfaces:

- **`packages/core`** — the product engine: the chat agent (system prompts, step preparation, tool
  context in `chat-agent.ts`), the action service (`actions/` — discovery, invocation, policy
  projections, and governance for connected integrations and managed capabilities), integration
  clients, the shared chat UI message contract (`chat-ui.ts`), and iMessage delivery. Core does not
  import Next.js, Fastify, or React; surfaces inject identity, persistence handles, and
  side-effect adapters.
- **`packages/brain`** — the knowledge domain: document model and schema, append-only evidence
  timelines, inline links, retrieval (BM25 + embeddings with graph-hop expansion), source-item
  normalization for every connected provider, and the CLI bundle that app and runner materialize
  inside sandboxes. A leaf package: its only external deps are `minisearch` and `yaml`.
- **`packages/db`** — the Drizzle schema (`schema.ts`) and one query module per domain, plus the
  serverless (`client.ts`) and pooled (`pool.ts`, for the runner) clients.
  `legacy-billing-schema.ts` and `llm-broker-schema.ts` hold the few public-schema tables that
  still run (see “What was removed” below).
- **`packages/agent-runtime`** — shared contracts: the model catalog, action-gateway wire types,
  per-turn HMAC ticket auth for sandboxed Claude Code, Codex app-server and Claude Code event
  normalization, cloud-coding engine descriptors, and schedule helpers.
- **`apps/app`** — the Next.js surface at my.opencompany.chat: WorkOS AuthKit auth, routes and
  server actions, the Electric live-sync proxy, billing (including the Stripe webhook at
  `/api/stripe/webhook`), and the internal gateways the runner calls. Routes stay thin; domain
  logic belongs in `lib/` services and, increasingly, `packages/core`.
- **`apps/runner`** — the long-lived execution surface (Fastify on Render): the durable turn
  worker, Brain ingestion and provider poll/flush workers, the schedule sweeper, the LLM broker
  for sandboxed CLIs, and the sandbox/coding-workspace/dictation transports.
- **`apps/macos`** (opencompany Quick) and the MCP connector (`apps/app/app/mcp`) are additional
  thin surfaces over the same core — evidence that the seam holds.
- Support: `packages/ui` (design system), `telemetry` (OTel traces/metrics), `observability`
  (structured logs + error capture), `analytics` (PostHog; `shared-*` is the residual
  billing/marketing catalog pending consolidation), `billing` (model pricing), `browser-tools`,
  `crypto`, `file-extract`.

## Execution model: durable turns

Interactive chat streams straight from `apps/app` (`app/api/chat/route.ts`); durability begins at
the turn queue. Everything backgroundable — cloud coding chats, tasks, workflows, scheduled runs —
is rows:

`chat_sessions` (kind: chat | task) → a runtime session row → a per-session FIFO of leased turns.

The runner’s `turn-worker.ts` claims turns with `FOR UPDATE SKIP LOCKED`, heartbeats the lease,
survives deploys via handoff and guarded recovery, and settles turn + session + task projection +
origin-chat notification in one fenced statement (`task-turn.ts`). Three engines share the queue
and are dispatched per turn:

- `opencompany` — in-process AI SDK loop (`opencompany-chat.ts`), no sandbox; parts are projected
  into chat messages by `opencompany-chat-projector.ts`.
- `codex` — persistent E2B sandbox driving the Codex app-server (`codex-chat.ts`,
  `codex-app-server.ts`), with dynamic host tools for actions and the Brain.
- `claude_code` — persistent E2B sandbox driving the Claude CLI (`claude-code-chat.ts`), reaching
  the same action catalog through a per-turn HMAC-ticketed MCP endpoint.

Tasks and workflows are projections over chat sessions, not a separate execution stack: workflow
steps are ordinary turns chained by settlement; schedules (`scheduler.ts`) create task sessions on
cron. Harness planning for Codex tasks lives in `harness.ts`.

## Boundaries

- **app → runner**: `/internal/*` routes (bearer `RUNNER_INTERNAL_TOKEN`) for wake nudges, sandbox
  status, coding-workspace/dictation ticket minting, and harness planning. The database is the
  queue; HTTP is only a nudge.
- **runner → app**: the action gateway (`/api/internal/action-gateway`), the Claude Code MCP bridge
  (`/api/internal/claude-actions`, ticket-authenticated because it is reachable from inside the
  sandbox), and Brain capture (`/api/internal/codex-brain-capture`) — so provider credentials and
  the internal bearer never enter E2B.
- **browser ↔ data**: Electric shapes through the authenticated proxy
  (`app/api/electric/v1/shape`); Postgres is the source of truth, the stream is the transport.

## Storage contracts (deliberately frozen names)

These predate the goat → opencompany rename and are kept stable on purpose. They are baked into
production rows, live user sandboxes, and external dashboards — renaming any of them is a
data/ops migration, not a refactor:

- the physical Postgres schema `goat` (`pgSchema("goat")` in `packages/db/src/schema.ts`) and
  everything under `drizzle/`;
- Electric wire table names (`goat.tasks`, `goat.chat_messages`, …);
- E2B sandbox working directories (`/home/user/opencompany-goat/*`, `/home/user/.opencompany-goat/*`);
- row-id prefixes (`goat_chat_`, `goat_task_`, `goat_codex_chat_*`, `goat_brain_*`, …);
- stored engine ids (`opencompany` | `codex` | `claude_code`) and event schema versions
  (`goat.harness.v1`, `goat.chat.debug.v1`, `goat.codex_chat.debug.v1`);
- telemetry service names (`opencompany-goat`, `opencompany-runner-goat`) and the `goat.*`
  span/metric/attribute names;
- browser storage keys (`opencompany-goat-theme`, `goat-active-workspace`, `goat-active-brain`)
  and the `goat-coding-workspace-v1` WebSocket protocol;
- the Infisical `/goat` folder and live third-party app identifiers (HubSpot project, Slack apps,
  WorkOS environments).

## What was removed (2026-08 foundation refactor)

The legacy first-generation product — `apps/web` and the `.agent`-file platform, its runner
engine, Inngest, WhatsApp messaging, the legacy memory system, and the PR-preview pipeline — was
deleted. Legacy public-schema tables remain in the database untouched but have no code; dropping
them (and retiring the legacy branches of the Stripe webhook) is a deliberate follow-up migration.

## Next extractions (known seams)

- Move the inline chat turn out of `app/api/chat/route.ts` into `packages/core`.
- Lift the durable-turn write side (`lib/codex-chat.ts`) and the task/workflow/schedule services
  out of the app into core.
- Extract the runner’s claim/lease/settle turn-runtime into a package so worker loops stop being
  re-implemented per worker.
- Merge `analytics/shared-*` into the product catalog.
