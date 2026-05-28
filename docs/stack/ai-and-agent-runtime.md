# AI and Agent Runtime

## Vercel AI Gateway

**What it is:** Model gateway for routing calls to providers such as OpenAI and Anthropic.

**What it does for us:** Gives the runner one gateway credential and provider-neutral model IDs for
agent runs. The model catalog currently exposes OpenAI GPT and Anthropic Claude fast/deep choices.

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

## OpenAI and Anthropic

**What they are:** AI model providers exposed through Vercel AI Gateway.

**What they do for us:** Provide the agent model choices shown in the editor and consumed by the
runner. The exact model IDs change more often than this register should; keep
`packages/agent-runtime/src/models.ts` as the source of truth for the current catalog.

**Where it is used:**

- `packages/agent-runtime/src/models.ts`.
- `apps/web/lib/agents/config.ts`.
- `apps/web/components/agent-editor/tools.ts`.

**Why we use them:** We want at least two high-quality provider families so agents can choose fast
or deep behavior without the product being locked to one model vendor.

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

## Runtime tools

A runtime tool is a callable capability exposed to the model during a session. Integrations are the
workspace-level external resources those tools may reference, and provider credentials are
implementation details for powering provider-backed tools.

Core tools are always available to runner sessions:

- `shell`
- `read_file`
- `edit_file`
- `write_file`
- `list_files`
- `git_diff`
- `tool_help`

Sandbox sessions do not clone the managed workspace repository. `work/` is an empty git repository
for session-local scratch changes, and configured Brain files are mounted separately under `brain/`.

Hosted tools are enabled by agent configuration:

- `exa_search`
- `exa_contents`
- `exa_answer`
- `web_fetch`

Provider-backed coding tools are also enabled by agent configuration:

- `amp_coder` when `@amp` is enabled and bound to a connected GitHub work repository

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
