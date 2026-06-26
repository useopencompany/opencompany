# The `.agent` file format

An agent is a single text file. Everything the platform knows about an agent — its name, instructions, session engine, model, and tools — lives in that file. The web editor, the GitHub sync, and the runtime all read the same format.

This is the spec.

## Anatomy

```yaml
---
title: "Fundraising copilot"
engine: opencompany
model: openai/gpt-5.4
tools:
  - exa
brain:
  - docs/README.md
  - product/
agents:
  - path: agents/sales-research/sales-research.agent
    name: Sales research
---

Research investors with @exa. Write careful fund-thesis summaries. Keep context from @brain/docs/README.md close. Ask @agent/sales-research for account notes.
```

A `.agent` file has two parts:

1. **Frontmatter** — a YAML block fenced by `---` lines. Deterministic metadata the runtime needs to dispatch the agent.
2. **Body** — Markdown that the model receives as its instructions. `@mention` tokens inside the body declaratively bind tools, Brain files/folders, repositories, skills, and workspace agents.

Files live at `agents/<slug>/<slug>.agent` in the workspace's GitHub repo, where `<slug>` is the lowercased, dash-joined title.

## Mentions are the source of truth

Some frontmatter fields are **derived from body mentions** rather than authored independently. When the editor serializes an agent:

- Unique supported `@tool` mentions → written to `tools:`.
- Unique supported `@brain/<path>` mentions → written to `brain:`.
- Unique supported `@skill/<id>` mentions → written to `skills:`.
- A plain `@github` mention writes `integrations.github.allRepositories: true`.
  This gives repository-aware coding tools live access to any repository the
  workspace's GitHub connection can reach.
- A supported GitHub repository mention, such as `@owner/repo` or its
  `@github/owner/repo` alias, is written to `integrations.github.repositories`
  and used by repository-aware coding tools.
- Unique supported `@agent/<slug>` mentions → written to `agents:`.
- The title input → written to `title:`.

Removing `@exa` removes the tool. Tool and context mentions stay in sync with what the runtime is configured to use.

Engine and model selection are per-agent config in `engine:` and `model:`. Body mentions do not change either field.

### Tiptap content is not the contract

The web editor may store a Tiptap JSON document so mentions can render as chips when the agent is reopened. That JSON is an editor presentation cache only. It can be stale, incomplete, or missing mention attributes after a client update, so persisted saves must never derive runtime config from Tiptap JSON when body text is available.

On save, the server derives mention-backed frontmatter/config from the body text that will be written to the `.agent` file, then stores sanitized Tiptap JSON separately for editor hydration. If body and Tiptap content disagree, the body wins for mention-backed fields.

## Frontmatter fields

### `title` — string, required

Human-readable name. Serialized as a YAML double-quoted string. Trimmed. Empty values become `"Untitled agent"`.

### `engine` — string, optional

Which session engine runs new sessions for the agent:

| Value | Behavior |
| ----- | -------- |
| `opencompany` | Default. Uses OpenCompany's native runner loop, model routing, tools, sandbox lifecycle, attachments, and after-session hooks. |
| `codex` | Uses the Codex CLI runner path for turns. Codex sessions use Codex-compatible session models and per-session reasoning settings; `RUNNER_CODEX_MODEL` remains the legacy/fallback CLI model. Codex sessions are text-only in v1. |

Missing `engine:` defaults to `opencompany` so existing agent files keep working. Generated files serialize the field explicitly.

### `model` — string, required

The model the OpenCompany engine runs on. Must be one of:

| ID                                         | Notes                                                           |
| ------------------------------------------ | --------------------------------------------------------------- |
| `openai/gpt-5.4-mini`                      | Default. Cost-efficient for agentic production work.            |
| `openai/gpt-5.4-nano`                      | Lowest-cost GPT for high-volume lightweight tasks.              |
| `openai/gpt-5.4`                           | High-capability reasoning across long workflows.                |
| `anthropic/claude-haiku-4.5`               | Cost-efficient Claude for fast workloads.                       |
| `anthropic/claude-sonnet-4.6`              | High-capability Claude for coding-heavy and professional tasks. |
| `anthropic/claude-opus-4.7`                | Highest-capability Claude for demanding agent workflows.        |
| `anthropic/claude-opus-4.8`                | Latest highest-capability Claude for demanding agent workflows. |
| `anthropic/claude-fable-5`                 | Mythos-class Claude for long-running, complex agent tasks.      |
| `google/gemini-3-flash`                    | Popular Gemini model with strong speed and long context.        |
| `google/gemini-3.1-flash-lite-preview`     | Very fast, low-cost Gemini for simple high-volume tasks.        |
| `deepseek/deepseek-v4-flash`               | High-throughput DeepSeek for cost-sensitive work.               |
| `mistral/mistral-medium-3.5`               | Mistral model balancing quality, latency, and cost.             |
| `minimax/minimax-m3`                       | Latest MiniMax with 1M context and agentic coding strength.     |
| `minimax/minimax-m2.7`                     | High-capability MiniMax for software engineering agents.        |
| `minimax/minimax-m2.7-highspeed`           | Fast MiniMax M2.7 variant for latency-sensitive agent work.     |
| `minimax/minimax-m2.5`                     | MiniMax for full-stack and multi-file code work.                |
| `minimax/minimax-m2.5-highspeed`           | Fast MiniMax M2.5 variant for responsive coding workflows.      |
| `minimax/minimax-m2.1`                     | MiniMax for reliable agentic coding with interleaved thinking.  |
| `minimax/minimax-m2.1-lightning`           | Speed-optimized MiniMax M2.1 for fast coding assistance.        |
| `minimax/minimax-m2`                       | MiniMax MoE model for coding and agentic tasks.                 |
| `moonshotai/kimi-k2.6`                     | Latest Kimi for long-horizon coding and agent workflows.        |
| `moonshotai/kimi-k2.5`                     | Kimi multimodal model for agents, coding, and vision tasks.     |
| `moonshotai/kimi-k2-thinking`              | Kimi reasoning model for long tool-call chains.                 |
| `moonshotai/kimi-k2-thinking-turbo`        | Faster Kimi reasoning variant for interactive workflows.        |
| `moonshotai/kimi-k2-turbo`                 | Speed-optimized Kimi K2 for latency-sensitive tool use.         |
| `moonshotai/kimi-k2`                       | Kimi K2 instruct model for coding and agentic pipelines.        |
| `xai/grok-4.3`                             | Latest Grok reasoning model with 1M context and tool use.       |
| `xai/grok-4.20-reasoning`                  | Long-context Grok reasoning model for agent workflows.          |
| `xai/grok-4.20-non-reasoning`              | Long-context Grok model for direct tool-using tasks.            |
| `xai/grok-4.1-fast-reasoning`              | Fast, low-cost Grok reasoning model with 1M context.            |
| `xai/grok-4.1-fast-non-reasoning`          | Fast, low-cost Grok model for direct answers.                   |
| `xai/grok-build-0.1`                       | xAI coding model for fast agentic software development.         |
| `zai/glm-5.1`                              | Latest GLM for coding-heavy and agentic engineering tasks.      |
| `zai/glm-5.2`                              | Latest GLM with improved reasoning and coding capabilities.     |
| `zai/glm-5-turbo`                          | Faster GLM 5 variant for production agent workflows.            |
| `zai/glm-5v-turbo`                         | Multimodal GLM 5 model for visual coding and GUI tasks.         |
| `openrouter/fusion`                        | OpenRouter multi-model router for research and critique.        |

Unknown model IDs fall back to `openai/gpt-5.4-mini` rather than failing the parse.

All models are routed through Vercel AI Gateway, so the file never references a provider SDK directly.

### `tools` — list of strings or tool objects

Each entry is a product-level tool ID, either as a string shorthand or as an
object when the tool has persisted configuration. Unknown IDs are silently
dropped. Labels, descriptions, runtime function names, and provider execution
details are catalog data in code, not `.agent` file data.

| ID    | Description                                      |
| ----- | ------------------------------------------------ |
| `exa` | Web research with search, content extraction, people lookup, and cited answers. |
| `x` | Read public X posts, profiles, timelines, discussions, and trends through the official X API. |
| `youtube` | Search YouTube, inspect video/channel metadata, list channel videos, and fetch transcripts through Supadata. |
| `tiktok` | Inspect public TikTok profiles, recent videos, comments, and search results through Apify; fetch direct-video metadata/transcripts through Supadata. |
| `instagram` | Inspect public Instagram profiles, recent posts/reels, comments, and profile search results through Apify; fetch direct-media metadata/transcripts through Supadata. |
| `amp` | Coding agent delegated into a sandboxed runtime. |
| `opencode` | Coding agent delegated into a sandboxed runtime, with attached or public GitHub repository support. |
| `codex` | Codex coding agent delegated into a sandboxed runtime, with attached or public GitHub repository support. |
| `linear` | Experimental workspace MCP access to Linear issues, projects, and comments. |
| `slack` | Experimental workspace MCP access to Slack search, messages, files, emoji, and users. |
| `notion` | Workspace MCP access to Notion search, pages, databases, comments, users, and teamspaces. |

```yaml
tools:
  - id: amp
    type: coding_agent
    provider: amp
    prCapable: true
  - id: codex
    type: coding_agent
    provider: codex
    label: Codex
    description: Delegate coding work to Codex inside an E2B sandbox, with attached or public GitHub repository support.
    prCapable: true
  - id: linear
    type: mcp
    server: linear
  - id: slack
    type: mcp
    server: slack
  - id: notion
    type: mcp
    server: notion
```

MCP tools are beta workspace tools. The `.agent` file only records the MCP server binding; tokens
and endpoint setup live in workspace MCP settings and are never serialized into the agent file.

### `brain` — list of strings

Each entry is a path inside `brain/` in the workspace repo. File paths mount one file. Folder paths must end in `/` and mount matching descendants.

```yaml
brain:
  - /
  - docs/README.md
  - product/
```

Use `/` to mount the whole Brain root. The runtime materializes mounted Brain files under `brain/` inside the session sandbox. Agents can read and edit only explicitly mentioned Brain files/folders. Edits are mirrored back to the app and synchronized to GitHub.

### `agents` — list of workspace agent references

Each entry binds another agent in the same workspace. The path points at the
target `.agent` file under `agents/`; `name` is a human-readable label for the
editor and runtime prompt.

```yaml
agents:
  - path: agents/sales-research/sales-research.agent
    name: Sales research
```

When a session runs, referenced agents expose an internal `delegate_to_agent`
runtime tool. Calling it creates an inspectable child session for the target
agent, hides that child from sidebar history, and returns that child session's
final answer plus `childSessionId` as a tool result. Later calls can pass that
`childSessionId` as `sessionId` with a new prompt to continue the same delegated
child session.

### `skills` — built-in ids, external skill references, and workspace skill references

Skills are agentskills.io-style folders of instructions that the runtime materializes
read-only into `./skills/<id>/` inside the session sandbox. The agent reads a skill's
`SKILL.md` on demand with `read_skill` (progressive disclosure); the system prompt only
advertises each enabled skill's name and description.

There are three kinds of entry. **Built-in skills** are bare string ids from the catalog
(`packages/agent-runtime/src/skills.ts`); unknown ids are dropped. Built-in skills marked
`defaultEnabled` are available in every session without being listed here, so the key is
usually omitted and only appears once additional opt-in skills exist.

```yaml
skills:
  - agent-self-edit
  - y-combinator-knowledge
```

Current addable built-in skills include:

- `first-principles` — a structured framework for breaking hard problems down to fundamentals.
- `humanizer` — editing guidance for making generated prose sound human.
- `y-combinator-knowledge` — YC-style startup sparring: office-hours framing, user obsession,
  MVP and growth pressure, fundraising discipline, and links to canonical YC/PG teachings.

**External skills** are brought in from a public GitHub repository (or a skills.sh page,
resolved through its backing GitHub repo). They serialize as an object carrying provenance
plus a denormalized name/description for the system-prompt advertisement:

```yaml
skills:
  - agent-self-edit
  - id: improve-codebase-architecture
    name: Improve Codebase Architecture
    description: Analyze codebases for architectural friction.
    source:
      type: github # or skills.sh
      url: https://github.com/mattpocock/skills
      ref: main # branch/tag the skill tracks
      path: skills/improve-codebase-architecture
```

The `id` is the mount slug (`./skills/<id>/`). The file contents are **not** stored in the
`.agent` file — they live in the workspace's `workspace_skill_snapshots` cache and are
materialized from there at session start. External skills are added in the editor by typing
`@skill` → "Add skill from GitHub URL", which resolves and snapshots the skill, then inserts
an `@skill/<id>` mention into the body (the body mention is what enables the skill; the
frontmatter object carries the resolved provenance).

External skills **track their branch**: the runner re-resolves each one to the branch HEAD
on session start (with a short freshness window), refreshing the snapshot in place. This
happens in the trusted runner host, never inside the sandbox; files are always mounted
root-owned and read-only. A malformed external object, or one whose snapshot can't be
resolved and isn't cached, is skipped rather than mounted. The runner's `update_agent_file`
self-edit path preserves existing external skills but cannot add new ones (it has no
resolver).

**Workspace skills** are company-authored Markdown skills created in OpenCompany's company
Skills tab. They are synced to the managed workspace repo at `skills/<id>/SKILL.md` and
serialize with workspace provenance:

```yaml
skills:
  - id: brand-voice
    name: Brand Voice
    description: Use the company voice and messaging rules.
    source:
      type: workspace
      path: skills/brand-voice
```

Like external skills, workspace skill file contents are not duplicated into `.agent` files.
Mentioning `@skill/<id>` in the body enables the skill for that agent; removing the mention
removes it from the saved config. Workspace skills are mounted read-only under
`./skills/<id>/` at session start.

For Codex-engine sessions, the runner also mirrors selected workspace/external skills into the
Codex work root at `.agents/skills/<id>/` so native Codex skill discovery can see them.
The mirror is tracked with `.agents/skills/.opencompany-managed-skills.json` and reconciles
only those managed ids, preserving repo-authored or user-created native Codex skills in the same
directory. OpenCompany runtime-only default skills remain in the OpenCompany `./skills` mount.

The first built-in skill, `agent-self-edit`, teaches the agent to evolve its own `.agent`
definition. With it enabled, the runtime exposes an internal `update_agent_file` tool: the
agent submits a complete new body and can optionally provide a new model and the complete
replacement list of recurring schedule triggers. The runner validates the request strictly
(rejecting empty bodies, unknown models, malformed content, or invalid schedule trigger
data rather than silently falling back to defaults), persists it with a version bump, and
queues the same async GitHub sync as an editor save. Changes apply to the agent's next
session. Title/slug, repositories, GitHub pull request triggers, and delegated agents are
preserved and cannot be changed this way.
As a guardrail, the runner rejects `update_agent_file` until the agent has read the
`agent-self-edit` SKILL.md (via `read_skill`) in the current session, so the edit is always
made with the skill's guidance in context.

### `integrations.github` — GitHub access object

GitHub access is derived from body mentions. A plain `@github` mention enables
live workspace-wide access:

```yaml
integrations:
  github:
    repositories: []
    allRepositories: true
```

`allRepositories: true` is not a snapshot of repository names. At runtime,
repository-aware coding tools resolve the requested `owner/repo` against the
workspace's connected GitHub installations. Agents with this access must pass an
explicit repository, such as the `repository` argument for coding tools or
`--repo owner/repo` for `gh` commands.

### `integrations.github.repositories` — list of repository objects

Each entry binds a workspace-authorized GitHub repository referenced by the body.
Both `@owner/repo` and `@github/owner/repo` serialize to the same repository
object.

```yaml
integrations:
  github:
    repositories:
      - id: opencompany-web
        fullName: opencompany/web
        defaultBranch: main
        binding:
          provider: github
          resourceType: repository
          externalId: "123456789"
          displayName: opencompany/web
          connection:
            externalId: "987654"
            label: OpenCompany
            accountName: opencompany
            accountType: Organization
```

`id` is the normalized repository ID used by tools and triggers. `fullName` is the GitHub `owner/repo` name shown in body mentions. `binding` is optional normalized runtime data that identifies the concrete provider resource and parent connection without making opaque database IDs part of the human-authored reference. Unknown or unauthorized repository mentions stay in the body but do not contribute to the compiled config.

### `triggers` — list of trigger objects

Pull request triggers reference repository IDs from `integrations.github.repositories`.

```yaml
triggers:
  - id: opencompany-web-pr
    type: github.pull_request
    repository: opencompany-web
    events:
      - opened
      - synchronize
    branches:
      - main
    enabled: true
```

Scheduled run triggers store a generated preset cron expression, an IANA timezone,
and the prompt to submit when the schedule fires. The editor generates these from
the "Run every..." UI; arbitrary cron text is not part of the MVP. Agents with the
`agent-self-edit` skill can replace their complete schedule-trigger list through
`update_agent_file`; omitting `triggers` preserves current schedules, and passing
`[]` removes all schedules. GitHub pull request triggers are preserved automatically.

```yaml
triggers:
  - id: weekday-brief
    type: agent.schedule
    cron: "0 9 * * 1-5"
    timezone: America/Los_Angeles
    prompt: Review open priorities and write a concise status brief.
    enabled: true
```

## The body

Markdown. The model sees it verbatim as system instructions. There is no preprocessing besides mention parsing.

### Mention syntax

`@<id>` where `<id>` is a tool ID, a Brain path, a workspace agent reference, or a GitHub `owner/repo`. Mentions can include `/`, `-`, `.`, and `_`. Trailing punctuation (`. , ; : ! ? ) ] }`) is stripped before lookup.

```text
Find investors with @exa.        ← @exa            (tool)
Read @brain/product/ first.      ← @brain/product/ (Brain folder)
Work in @opencompany/web.        ← @opencompany/web (GitHub repository)
Read @brain/ first.              ← @brain/         (Brain root folder)
Ask @agent/sales-research.       ← @agent/sales-research (workspace agent)
```

Unknown `@text` that doesn't match a tool, Brain path, repository, or workspace agent stays in the body as plain text — no error, no contribution to frontmatter.

### Profile (`agent/user.md`)

Every session injects one small "profile" file from the agent folder directly into the system
prompt, so the agent carries durable context into each session without having to retrieve it:

- **`agent/user.md`** — who the user is: identity, preferences, communication style, goals.

It is auto-created empty on first use and edited by the agent with ordinary file tools as it
learns. It is deliberately small: hard-capped at ~3 KB when injected (content beyond the cap is
truncated with a visible marker). The profile is **not** a general facts store — every other
durable fact (specific people, companies, projects, decisions, lessons, conventions) belongs in
structured memory (`agent/memory/`, via the `memory` tool). Because the prompt is built at session
start, edits take effect on the **next** session (a frozen snapshot per session). This applies to
any agent that has this file — it is not specific to the personal agent.

### After-session memory hook

Add `#after-session` inside the body to enable a background pass after a session has been idle for 3 minutes. The hook prompt is the text after the first `#after-session` marker through the end of that paragraph. The marker remains part of the normal instructions, but the runtime also uses the parsed prompt for an internal after-session run.

```text
Help the user during the session. #after-session Update memory with durable preferences and decisions from the transcript.
```

The after-session run is not a visible chat turn. It reuses the agent loop and can use configured tools, but should persist only clear long-lived context: an explicit user request to remember/save/update something, a correction to stale information, or a stable preference, identity fact, ongoing project, decision, or convention likely to matter in future sessions. Durable facts about who the user is go into the profile (`agent/user.md`, kept tight given the ~3 KB cap); other qualifying durable facts go into structured memory via the `memory` tool. Do not create Brain or Personal Brain files unless the conversation explicitly asked for a named persistent file update.

## Storage layout

```text
workspace-repo/
└── agents/
    ├── fundraising-copilot/fundraising-copilot.agent
    ├── ops-triage/ops-triage.agent
    └── sales-research/sales-research.agent
```

One agent per file. The slug must match the filename; the platform regenerates it from the title on every save.

If two agents resolve to the same slug, later ones get a `-2`, `-3`, … suffix (`agents/research/research.agent`, `agents/research-2/research-2.agent`).

### Renames

- **Editor-originated** (changing the title): the new slug is computed at save time, the file is written at the new path, and the old GitHub file is deleted in the same projection commit (tracked via `previousPath` / `previousBlobSha` on the agent's `workspace_sync_jobs` row; the producer also clears any stale outbox row left at the old path so the rename never re-creates the old file).
- **GitHub-originated** (renaming the file directly in the repo): handled only through manual
  import/reconciliation. Because the app keys workspace sync by file path, a GitHub rename is
  treated as a new agent on the next import and can stay out of sync until the editor re-saves the
  canonical Postgres state.

## Save behavior

When the editor saves an agent:

1. Postgres receives the title, body, body-derived config, sanitized editor content, content hash, and version — synchronously. This is the "saved" state from the user's perspective.
2. A `workspace_sync_jobs` outbox row is enqueued (coalesced on `(workspaceId, repoPath)`) with a `nextRunAt` ~10 seconds out, debouncing rapid edits. If the title change produced a new path, the previous path and blob SHA are recorded on the row so the projector can delete the old GitHub file.
3. `workspace.sync_requested` is dispatched to Inngest.
4. The projector (`projectWorkspaceToGitHub`) commits the file to GitHub asynchronously, as one commit alongside any other due workspace changes.

The editor only waits on step 1. GitHub sync status is surfaced separately and never blocks editing — a failing sync shows on the agent row, not on the save button.

## Validation rules

The parser is intentionally lenient. A hand-edited `.agent` file should never refuse to load.

| Rule                             | Behavior on violation                          |
| -------------------------------- | ---------------------------------------------- |
| Title empty                      | Becomes `"Untitled agent"`                     |
| Missing `engine:`                | Defaults to `opencompany`                     |
| Unknown engine in `engine:`      | Defaults to `opencompany` while leniently parsing; strict validation rejects it |
| Unknown model in `model:`        | Falls back to `openai/gpt-5.4-mini`            |
| Unknown tool in `tools:`         | Dropped                                        |
| Missing frontmatter              | Whole file treated as body, defaults applied  |
| Unparseable frontmatter key      | Skipped; other keys still parsed              |
| `\r\n` line endings              | Normalized to `\n`                             |

## Examples

### Minimal

```yaml
---
title: "Notes"
engine: opencompany
model: openai/gpt-5.4-mini
tools: []
---

Summarize whatever I paste below.
```

### With a tool and a deep model

```yaml
---
title: "Investor research"
engine: opencompany
model: openai/gpt-5.4
tools:
  - exa
---

Find recent fund announcements with @exa. Write the brief carefully.
```

### Letting mentions drive tools and context

Author with only the body. The serializer fills in the frontmatter from the mentions:

```yaml
---
title: "Research"
engine: opencompany
model: openai/gpt-5.4-mini
tools:
  - exa
---

Find investors with @exa and write a concise brief.
```

You never touched `tools:`. It reflects what the body actually references. The engine and model remain explicit per-agent config.

## Compiled config

The runtime consumes a normalized `AgentConfig` (defined in `packages/db/src/schema.ts`):

```ts
{
  schemaVersion: "agent.v1",
  engine: "opencompany",
  title: "Investor research",
  instructions: "Find recent fund announcements with @exa...",
  model: {
    provider: "vercel-ai-gateway",
    name: "openai/gpt-5.4",
  },
  tools: [
    { id: "exa", type: "hosted_tool", label: "exa", description: "Web research with search, content extraction, people lookup, and cited answers." },
  ],
  brain: [
    { path: "/", type: "folder" },
    { path: "docs/README.md", type: "file" },
    { path: "product/", type: "folder" },
  ],
  agents: [
    { path: "agents/sales-research/sales-research.agent", name: "Sales research" },
  ],
  afterSession: {
    enabled: true,
    prompt: "Update memory with durable preferences and decisions from the transcript.",
    idleDelaySeconds: 180,
  },
  integrations: {
    github: {
      repositories: [],
    },
  },
  triggers: [
    {
      id: "weekday-brief",
      type: "agent.schedule",
      cron: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
      prompt: "Review open priorities and write a concise status brief.",
      enabled: true,
    },
  ],
}
```

`schemaVersion: "agent.v1"` is a forward-compatibility hook. New versions will be additive — older files stay readable.

## Where the code lives

- Parser and serializer — `packages/agent-runtime/src/agent-file.ts`
- Mention parsing and body-derived config — `packages/agent-runtime/src/mentions.ts`
- Supported model and tool catalogs — `packages/agent-runtime/src/models.ts`, `packages/agent-runtime/src/tools.ts`
- Tiptap preview adapter — `apps/web/lib/agents/config.ts`
- Compiled config type — `packages/agent-runtime/src/types.ts` (`AgentConfig`)
- Editor — `apps/web/components/agent-editor/AgentEditor.tsx`
- Save action and GitHub sync — `apps/web/lib/agents/actions.ts`, `apps/web/lib/inngest/functions.ts`

## FAQ

**Can I commit `.agent` files by hand?**
Yes. Push them to the workspace repo and trigger a manual import/reconciliation. The web app reads
the format directly and writes the imported result into Postgres; normal editor saves remain the
canonical app state after the database transaction succeeds.

**What happens if two saves race?**
Every save carries a content hash and version. Inngest debounces by ~10 seconds and limits one in-flight sync per agent. If GitHub returns a conflicting blob SHA, the sync refetches and retries.

**How do I add a new model or tool?**
Add models to `packages/agent-runtime/src/models.ts`. Add product-level tools
to `AGENT_TOOL_CATALOG` and runtime callable tools to
`RUNTIME_TOOL_DEFINITIONS` in `packages/agent-runtime/src/tools.ts`; the web
editor consumes that catalog through `apps/web/lib/agents/config.ts` and
`apps/web/components/agent-editor/tools.ts`. Older files that don't reference
the new ID are unaffected; clients that don't recognize a new ID will fall back
gracefully.

Tool availability is mostly static for the MVP. Beta MCP tools are gated by workspace experiments
and workspace MCP server setup before they appear in the editor or run in the runner. The catalog
records each tool's default enabled state, credential source, platform env requirements, and
required workspace resource type when applicable.

**How do I evolve the format?**
Bump `schemaVersion` in `packages/db/src/schema.ts` and add a normalizer in `parseAgentFile`. Keep additions additive so existing files keep parsing as `agent.v1` until they're re-serialized.
