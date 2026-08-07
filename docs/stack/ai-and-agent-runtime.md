# AI and Agent Runtime

## Vercel AI Gateway

**What it is:** Model gateway for routing calls to model providers.

**What it does for us:** Gives the runner one gateway credential and provider-neutral model IDs for
agent runs. The exact catalog changes over time; `packages/agent-runtime/src/models.ts` is the
source of truth for current fast/deep model choices.

**Where it is used:**

- `VERCEL_AI_GATEWAY_API_KEY` in `.env.example`.
- `apps/runner/src/env.ts`.
- `apps/runner/src/agent-loop.ts`.
- `apps/runner/src/session-title.ts`.
- `packages/agent-runtime/src/models.ts`.

**Why we use it:** It reduces direct provider integration work and gives us one place to route model
traffic while we are still learning model/provider fit.

**Owner:** AI Platform.

**Reconsider if:** Gateway behavior limits provider-specific features, latency/cost needs require
direct provider routing, or observability/accounting through the gateway is insufficient.

## AI SDK

**What it is:** TypeScript library for model calls and tool orchestration.

**What it does for us:** Provides the gateway client and model call helpers used by the runner,
including usage objects that feed billing/accounting.

**Where it is used:**

- `apps/runner/src/agent-loop.ts`.
- `apps/runner/src/session-title.ts`.
- `apps/runner/src/usage.ts`.

**Why we use it:** It gives a provider-neutral API for text generation, tool calls, and usage
normalization without each model provider needing bespoke runner code.

**Owner:** AI Platform.

**Reconsider if:** We need lower-level streaming/tool control than the SDK provides, or billing
usage needs cannot be normalized reliably through it.

## Gateway model providers

**What they are:** AI model providers exposed through Vercel AI Gateway.

**What they do for us:** Provide the agent model choices shown in the editor and consumed by the
runner. The exact model IDs change more often than this register should; keep
`packages/agent-runtime/src/models.ts` as the source of truth for the current catalog.

**Where it is used:**

- `packages/agent-runtime/src/models.ts`.
- `apps/web/lib/agents/config.ts`.
- `apps/web/components/agent-editor/tools.ts`.

**Why we use them:** We want multiple high-quality provider families so agents can choose fast or
deep behavior without the product being locked to one model vendor.

**Owner:** AI Platform.

**Reconsider if:** Quality, cost, latency, reliability, or enterprise terms make another provider a
better default; or if one provider family clearly becomes unnecessary.

## E2B

**What it is:** Hosted sandbox runtime.

**What it does for us:** Runs isolated agent workspaces for shell, file, and git tools. The runner
creates/connects sandboxes, prepares workspaces, streams runtime events, and tracks sandbox IDs on
agent sessions.

**Where it is used:**

- `apps/runner/src/sandbox.ts`.
- `apps/runner/src/agent-loop.ts`.
- `apps/runner/src/env.ts`.
- `E2B_API_KEY`, `OPENCOMPANY_E2B_TEMPLATE`, `OPENCOMPANY_AMP_E2B_TEMPLATE`,
  `OPENCOMPANY_CODEX_E2B_TEMPLATE`,
  `RUNNER_E2B_IDLE_TIMEOUT_MS` in `.env.example`.
- `docs/runner.md`.

**Why we use it:** Agents need code/file execution in isolated environments. E2B gives us that
without building and operating a sandbox fleet ourselves.

**Owner:** AI Platform.

**Reconsider if:** Sandbox lifecycle cost, startup latency, data isolation, network control, or
runtime customization requirements outgrow hosted E2B.

## Exa

**What it is:** Web search API.

**What it does for us:** Powers the optional `@exa` hosted agent tool and opencompany main chat's
lightweight `web_search` tool. Agents use Exa search for source discovery and vertical
people/company/news/research lookups, Exa contents for clean LLM-ready extraction from known URLs,
and Exa answer for short cited web-backed answers. chat uses one cheap Exa search for simple
current public-web questions. The runner also keeps a direct HTTP `web_fetch` fallback for simple
HTML/text pages.

**Where it is used:**

- `packages/agent-runtime/src/tools.ts`.
- `apps/runner/src/hosted-tools.ts`.
- `apps/app/app/api/chat/route.ts`.
- `apps/web/components/agent-editor/tools.ts`.
- `EXA_API_KEY` in `.env.example`.

**Why we use it:** Agents need current web evidence, company/person/news/research lookup, and
citation-ready result URLs. Keeping it as an explicit tool keeps web access auditable at the agent
configuration level.

**Status:** Optional. Agents can run without Exa unless they enable `@exa`.

**Owner:** AI Platform.

**Reconsider if:** Search quality, latency, cost, coverage, compliance, or citation needs are better
served by another search provider or by first-party browser/fetch infrastructure.

## X Scraping

**What it is:** Apify-backed public scraping for X posts, profiles, timelines, and discussions.

**What it does for us:** Powers the optional `@x` hosted agent tool. Agents can search public posts,
inspect profiles, read recent user timelines, and explore a post's replies/comments for social
listening and complaint analysis. V1 does not support login-gated/private data or trends.

**Where it is used:**

- `packages/agent-runtime/src/tools.ts`.
- `apps/runner/src/hosted-tools.ts`.
- `apps/web/components/agent-editor/tools.ts`.
- `APIFY_API_TOKEN` in `.env.example`.

**Why we use it:** Agents need direct access to X's public conversation for research and social
listening. Apify keeps V1 cost and scope bounded while preserving normalized model-facing outputs so
providers can be swapped later.

**Status:** Optional. Agents can run without X unless they enable `@x`.

**Owner:** AI Platform.

**Reconsider if:** Official API cost, rate limits, coverage, compliance requirements, or customer
credential needs make workspace-owned credentials or another licensed data provider a better fit.

## Apify (Instagram, TikTok social data)

**What it is:** A hosted actor platform used for public Instagram and TikTok profile, feed,
comment, and search scraping.

**What it does for us:** Powers the profile-oriented `@instagram` and `@tiktok` hosted tools:
profile lookup, recent profile posts/videos, direct post/video metadata, comments, and search.
The runner normalizes actor-specific output into stable Profile, Post, and Comment shapes and keeps
actor ids hidden from agents.

**Where it is used:**

- `packages/agent-runtime/src/tools.ts`.
- `apps/runner/src/hosted-tools.ts`.
- `APIFY_API_TOKEN` in `.env.example`.

**Why we use it:** Supadata is a good fit for transcripts, but its public social endpoints are
direct-media oriented. Apify actors cover handle/profile URLs, recent posts/reels/videos, comments,
and search, which match real agent use cases like "research this creator" or "summarize recent
posts from this account." The adapter is provider-agnostic so Bright Data or Data365 can be added
later without changing the model-facing tool names.

**Status:** Optional. Agents can run without Apify unless they enable `@tiktok` or `@instagram`
and use profile/feed/comment/search tools. V1 is public data only: no login cookies, private
profiles, follower/following list scraping, or contact-field extraction.

**Owner:** AI Platform.

**Reconsider if:** Actor reliability, pricing, scale requirements, or compliance requirements make
Bright Data, Data365, official APIs, or first-party infrastructure a better fit.

## Supadata (YouTube, TikTok, Instagram)

**What it is:** A hosted API for YouTube search, YouTube video/channel metadata, universal social
media metadata, and — most importantly — video transcripts, with AI-generated transcription as a
fallback when a video has no captions.

**What it does for us:** Powers the optional `@youtube` hosted agent tools and the direct-media
metadata/transcript tools inside `@tiktok` and `@instagram`. Agents can search YouTube, read a
video's transcript as text (so the model can "watch" it), inspect YouTube video/channel metadata,
enumerate a channel's recent uploads, and inspect/read public TikTok and Instagram media via
Supadata's universal metadata and transcript endpoints.

**Where it is used:**

- `packages/agent-runtime/src/tools.ts`.
- `apps/runner/src/hosted-tools.ts`.
- `apps/web/components/agent-editor/tools.ts`.
- `SUPADATA_API_KEY` in `.env.example`.

**Why we use it:** The official YouTube Data API cannot return transcripts for arbitrary videos
(captions download requires OAuth and only works for videos you own), and open-source transcript
scrapers are blocked from datacenter IPs. Supadata gives reliable server-side transcripts plus
search and metadata behind one `x-api-key` GET API, matching the existing hosted-tool pattern.

**Status:** Optional. Agents can run without Supadata unless they enable `@youtube`, `@tiktok`, or
`@instagram`. TikTok and Instagram profile scraping, comments, and search are handled by Apify; the
Supadata integration remains for direct public media URLs and transcripts.

**Owner:** AI Platform.

**Reconsider if:** Transcript reliability, cost, coverage (e.g. comments), or compliance needs make
another provider or first-party infrastructure a better fit.

## Runtime tools

A runtime tool is a callable capability exposed to the model during a session. Integrations are the
workspace-level external resources those tools may reference, and provider credentials are
implementation details for powering provider-backed tools.

Core tools are always available to runner sessions:

- `shell`
- `read_file`
- `read_skill`
- `edit_file`
- `write_file`
- `list_files`
- `git_diff`
- `ask_user_question`
- `tool_help`

Sandbox sessions do not clone the managed workspace repository. `work/` is an empty scratch git
repository for session-local changes, and configured Brain files are mounted separately under
`brain/`. Connected GitHub repositories are lazy: `gh` metadata commands can run before clone, but
code/file edits should clone the target repository into `work/<repo>` first. With one attached
repository the runner sets `GH_REPO`; with multiple attached repositories, `gh` commands must pass
`--repo owner/repo`.

Hosted tools are enabled by agent configuration:

- `exa_search`
- `exa_contents`
- `exa_answer`
- `x_search_posts`
- `x_get_profile`
- `x_get_user_posts`
- `x_get_discussion`
- `youtube_search`
- `youtube_get_video`
- `youtube_get_transcript`
- `youtube_get_channel`
- `youtube_list_channel_videos`
- `tiktok_get_metadata`
- `tiktok_get_transcript`
- `instagram_get_metadata`
- `instagram_get_transcript`
- `web_fetch`

Internal delegation tools are enabled by agent configuration:

- `delegate_to_agent` when the agent references other workspace agents; it can start an inspectable
  child session hidden from sidebar history or continue one of its own prior child sessions by `sessionId`

Skill-enabled tools are enabled by agent skill configuration:

- `read_skill` reads mounted skill files from the read-only `skills/<id>/` tree
- `update_agent_file` when the agent enables `agent-self-edit`; it validates and persists changes to
  the agent's own `.agent` configuration and queues GitHub sync

Provider-backed coding tools are also enabled by agent configuration:

- `amp_coder` when `@amp` is enabled and bound to a connected GitHub work repository
- `opencode_coder` when `@opencode` is enabled; it can target attached, integration-wide, or public GitHub repositories
- `codex_coder` when `@codex` is enabled; it can target attached, integration-wide, or public GitHub repositories

These coding-agent harnesses own their coding checkout and may clone the selected connected
repository directly into `work/` for that tool run. They share the repo-clone, diff, draft-PR,
artifact, and secret-redaction plumbing in `apps/runner/src/coding-agent-shared.ts`.

opencode runs headless as `opencode run --format json` inside the same coding sandbox template.
It is configured through a generated `opencode.json` (custom `@ai-sdk/openai-compatible` provider,
`OPENCODE_CONFIG` env). When the runner's **LLM broker** is active (prod/preview, where the runner
has a public URL), that config points at the runner's `/broker/gateway/v1` reverse proxy and the
subprocess receives only a short-lived per-delegation token (`OPENCOMPANY_LLM_BROKER_TOKEN`) — no
raw provider key enters the sandbox, and the broker's server-side metering
(`llm_broker_tokens`/`llm_broker_requests`, settled into one `agent_session_tool_usage` row with
`costSource: "broker_metered"`) is the billable record; opencode's self-reported token usage is
recorded display-only at cost 0. Without the broker (local dev, or the
`RUNNER_LLM_BROKER_ENABLED=false` kill switch) it falls back to the legacy direct
`VERCEL_AI_GATEWAY_API_KEY` injection and platform-priced self-reported usage. The model is chosen
per tool call via the optional `model` argument (validated against `AGENT_MODEL_CATALOG`),
defaulting to a fixed platform model when omitted. The memory CLI's model-backed retrieval routes
through the same broker (`MEMORY_GATEWAY_BASE_URL` + token in place of the raw key).

Codex engine sessions run headless inside the template selected by
`OPENCOMPANY_CODEX_E2B_TEMPLATE`, defaulting to E2B's `codex` template. Codex engine turns route
through a persistent `codex app-server --listen ws://127.0.0.1:...` daemon in the same E2B sandbox,
with a short-lived per-turn Bun JSONL bridge to the app-server websocket. `codex_coder` remains on
`codex exec`.
Codex templates are expected to be
provisioned with 8 vCPU and 8192 MB RAM; the runner records Codex sandbox usage against that
allocation for billing and observability. The repo-owned `apps/runner/e2b/codex` template builds
`opencompany-codex-toolbox`, extending E2B's `codex` template with `rg`, `fd`, `jq`, `curl`, `git`,
`gh`, Bun, Node/npm, the pinned Codex CLI, Playwright, and Playwright-managed Chromium.
Production/company runs use the workspace Codex account connected in company
settings: the runner writes an isolated `${CODEX_HOME}/config.toml` with file-backed ChatGPT auth,
injects the encrypted workspace `auth.json` cache into that home, and rotates the encrypted cache
after successful runs because the CLI may refresh tokens. Codex token usage from this
subscription-backed path is recorded display-only at cost 0; OpenCompany credits still cover the E2B
sandbox compute.

The legacy OpenAI API-key path is kept only as an explicit fallback (`RUNNER_CODEX_API_KEY_FALLBACK_ENABLED`).
When that fallback and the LLM broker are active, Codex receives only `OPENCOMPANY_LLM_BROKER_TOKEN`
and the server-side `OPENAI_CODEX_API_KEY` is attached by the broker. Without the broker, the Codex
process receives `CODEX_API_KEY`. Active Codex sessions persist their selected Codex model on
`agent_sessions` and pass it to app-server; `RUNNER_CODEX_MODEL` defaults to `gpt-5.5` as the
fallback for `codex_coder`.

> Foundational note: opencode also speaks the Agent Client Protocol (`opencode acp`, JSON-RPC over
> stdio). A future iteration can run harnesses through an in-runner ACP client to surface their
> individual tool calls and permission requests through the existing approval gate, and to bring
> additional harnesses (Claude Code, Gemini) the same way. The current opencode and Codex
> integrations intentionally use the simpler one-shot CLI paths that mirror AMP.

These harnesses run in coding sandbox templates (`OPENCOMPANY_AMP_E2B_TEMPLATE` for AMP/opencode
and `OPENCOMPANY_CODEX_E2B_TEMPLATE` for Codex). The `opencode` and `codex` CLIs are made
available defensively: their tool files check for the binary and install on demand if missing, so the
tools work on older templates without a rebuild. The durable option is to bake the CLI into the
coding template and keep the on-demand install path as a fallback.

MCP tools are enabled by workspace setup plus agent configuration:

- `linear__*` tools when Linear MCP is configured for the workspace and the agent mentions `@linear`
- `slack__*` tools when Slack MCP is configured for the workspace and the agent mentions `@slack`
- `notion__*` tools when Notion MCP is configured for the workspace and the agent mentions `@notion`

**Source of truth:** `packages/agent-runtime/src/tools.ts`.

The static agent tool catalog also records availability metadata for future workspace-level
administration: the stable tool id, label, runtime tools it exposes, default enabled state,
credential source, required platform env vars, and required workspace resource type when applicable.
For the MVP, all stable catalog tools are available to every workspace. Beta MCP tools are an
exception: they require a workspace experiment row, a `workspace_mcp_servers` entry, and encrypted
workspace MCP credentials. Resource-bound tools still validate the concrete workspace connection or
resource when the tool runs, and platform-backed tools fail with setup errors when required env vars
are missing.

**Operational rule:** Adding a runtime tool changes product capability, safety posture, billing
surface, and docs. Update this register, the agent file docs, and tests in the same change.
