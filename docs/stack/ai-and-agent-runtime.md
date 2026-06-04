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
  `RUNNER_E2B_IDLE_TIMEOUT_MS` in `.env.example`.
- `docs/runner.md`.

**Why we use it:** Agents need code/file execution in isolated environments. E2B gives us that
without building and operating a sandbox fleet ourselves.

**Owner:** AI Platform.

**Reconsider if:** Sandbox lifecycle cost, startup latency, data isolation, network control, or
runtime customization requirements outgrow hosted E2B.

## Exa

**What it is:** Web search API.

**What it does for us:** Powers the optional `@exa` hosted agent tool. Agents use Exa search for
source discovery and vertical people/company/news/research lookups, Exa contents for clean
LLM-ready extraction from known URLs, and Exa answer for short cited web-backed answers. The runner
also keeps a direct HTTP `web_fetch` fallback for simple HTML/text pages.

**Where it is used:**

- `packages/agent-runtime/src/tools.ts`.
- `apps/runner/src/hosted-tools.ts`.
- `apps/web/components/agent-editor/tools.ts`.
- `EXA_API_KEY` in `.env.example`.

**Why we use it:** Agents need current web evidence, company/person/news/research lookup, and
citation-ready result URLs. Keeping it as an explicit tool keeps web access auditable at the agent
configuration level.

**Status:** Optional. Agents can run without Exa unless they enable `@exa`.

**Owner:** AI Platform.

**Reconsider if:** Search quality, latency, cost, coverage, compliance, or citation needs are better
served by another search provider or by first-party browser/fetch infrastructure.

## X API

**What it is:** Official API for reading public X posts, profiles, timelines, discussions, and
trends.

**What it does for us:** Powers the optional `@x` hosted agent tool. Agents can search public posts,
inspect profiles, read recent user timelines, explore a post's replies and quote posts, and fetch
location-based trends without scraping or browser automation.

**Where it is used:**

- `packages/agent-runtime/src/tools.ts`.
- `apps/runner/src/hosted-tools.ts`.
- `apps/web/components/agent-editor/tools.ts`.
- `X_API_BEARER_TOKEN` in `.env.example`.

**Why we use it:** Agents need direct access to X's public conversation for research and social
listening. Using the official API keeps the first version stable, auditable, and aligned with X's
developer terms.

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
- `x_get_trends`
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
- `opencode_coder` when `@opencode` is enabled and bound to a connected GitHub work repository

These coding-agent harnesses own their coding checkout and may clone the selected connected
repository directly into `work/` for that tool run. They share the repo-clone, diff, draft-PR,
artifact, and secret-redaction plumbing in `apps/runner/src/coding-agent-shared.ts`.

opencode runs headless as `opencode run --format json` inside the same coding sandbox template.
It is configured to reach the platform's Vercel AI Gateway through a generated `opencode.json`
(custom `@ai-sdk/openai-compatible` provider, `OPENCODE_CONFIG` env), so it reuses the existing
`VERCEL_AI_GATEWAY_API_KEY` rather than provisioning raw provider keys into the sandbox. The model
is chosen per tool call via the optional `model` argument (validated against `AGENT_MODEL_CATALOG`),
defaulting to a fixed platform model when omitted. Cost is recorded from opencode's reported token
usage; dollar attribution is tracked through gateway spend (opencode has no per-run cost API).

> Foundational note: opencode also speaks the Agent Client Protocol (`opencode acp`, JSON-RPC over
> stdio). A future iteration can run harnesses through an in-runner ACP client to surface their
> individual tool calls and permission requests through the existing approval gate, and to bring
> additional harnesses (Claude Code, Codex, Gemini) the same way. Phase 1 intentionally uses the
> simpler one-shot `opencode run` path that mirrors AMP.

Both harnesses run in the coding sandbox template (which carries `git`, `gh`, and `amp`). The
`opencode` CLI is made available defensively: `opencode-tool.ts` checks for the binary and installs
it on demand if missing, so the tool works on the current template without a rebuild. The durable
option is to bake opencode into `OPENCOMPANY_AMP_E2B_TEMPLATE` — either via the installer or by
basing that image on e2b's prebuilt `opencode` template and layering `git`/`gh`/`amp` on top. We do
not point the runner directly at e2b's stock `opencode` template because a session uses one template
and still needs `gh`/`amp` for the other tools.

Experimental MCP tools are enabled by workspace setup plus agent configuration:

- `linear__*` tools when the workspace has the MCP beta on, Linear MCP is configured, and the
  agent mentions `@linear`
- `slack__*` tools when the workspace has the MCP beta on, Slack MCP is configured, and the agent
  mentions `@slack`

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
