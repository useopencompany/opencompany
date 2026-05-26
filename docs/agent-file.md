# The `.agent` file format

An agent is a single text file. Everything the platform knows about an agent — its name, instructions, the model that runs it, and the tools it can call — lives in that file. The web editor, the GitHub sync, and the runtime all read the same format.

This is the spec.

## Anatomy

```yaml
---
title: "Fundraising copilot"
model: openai/gpt-5.4
tools:
  - exa
brain:
  - docs/README.md
  - product/
---

Research investors with @exa. Use @deep for fund-thesis write-ups. Keep context from @brain/docs/README.md close.
```

A `.agent` file has two parts:

1. **Frontmatter** — a YAML block fenced by `---` lines. Deterministic metadata the runtime needs to dispatch the agent.
2. **Body** — Markdown that the model receives as its instructions. `@mention` tokens inside the body declaratively bind models, tools, and Brain files/folders.

Files live at `agents/<slug>.agent` in the workspace's GitHub repo, where `<slug>` is the lowercased, dash-joined title.

## Mentions are the source of truth

Frontmatter is **derived from the body**, not authored independently. When the editor serializes an agent:

- The most recent supported `@model` mention wins → written to `model:`.
- Unique supported `@tool` mentions → written to `tools:`.
- Unique supported `@brain/<path>` mentions → written to `brain:`.
- A supported GitHub repository mention, such as `@owner/repo`, is written to
  `integrations.github.repositories` and used by repository-aware coding tools.
- The title input → written to `title:`.

Editing `@deep` into the body changes the model. Removing `@exa` removes the tool. One source of truth, zero drift between what the instructions reference and what the runtime is configured to do.

If the body has no model mention, `model:` defaults to `openai/gpt-5.4-mini`.

### Tiptap content is not the contract

The web editor may store a Tiptap JSON document so mentions can render as chips when the agent is reopened. That JSON is an editor presentation cache only. It can be stale, incomplete, or missing mention attributes after a client update, so persisted saves must never derive runtime config from Tiptap JSON when body text is available.

On save, the server derives frontmatter/config from the body text that will be written to the `.agent` file, then stores sanitized Tiptap JSON separately for editor hydration. If body and Tiptap content disagree, the body wins.

## Frontmatter fields

### `title` — string, required

Human-readable name. Serialized as a YAML double-quoted string. Trimmed. Empty values become `"Untitled agent"`.

### `model` — string, required

The model the agent runs on. Must be one of:

| ID                            | Notes                                                           |
| ----------------------------- | --------------------------------------------------------------- |
| `openai/gpt-5.4-mini`         | Default. Cost-efficient for agentic production work.            |
| `openai/gpt-5.4`              | High-capability reasoning across long workflows.                |
| `anthropic/claude-haiku-4.5`  | Cost-efficient Claude for fast workloads.                       |
| `anthropic/claude-sonnet-4.6` | High-capability Claude for coding-heavy and professional tasks. |

Unknown model IDs fall back to `openai/gpt-5.4-mini` rather than failing the parse.

All models are routed through Vercel AI Gateway, so the file never references a provider SDK directly.

### `tools` — list of strings

Each entry is a tool ID. Unknown IDs are silently dropped.

| ID    | Description                                      |
| ----- | ------------------------------------------------ |
| `exa` | Deep research on the web and people.             |
| `amp` | Coding agent delegated into a sandboxed runtime. |

### `brain` — list of strings

Each entry is a path inside `brain/` in the workspace repo. File paths mount one file. Folder paths must end in `/` and mount matching descendants.

```yaml
brain:
  - docs/README.md
  - product/
```

The runtime materializes mounted Brain files under `brain/` inside the session sandbox. Agents can read and edit only explicitly mentioned Brain files/folders. Edits are mirrored back to the app and synchronized to GitHub.

### `integrations.github.repositories` — list of repository objects

Each entry binds a workspace-authorized GitHub repository referenced by the body.

```yaml
integrations:
  github:
    repositories:
      - id: opencompany-web
        fullName: opencompany/web
        defaultBranch: main
```

`id` is the normalized repository ID used by tools and triggers. `fullName` is the GitHub `owner/repo` name shown in body mentions. Unknown or unauthorized repository mentions stay in the body but do not contribute to the compiled config.

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

## The body

Markdown. The model sees it verbatim as system instructions. There is no preprocessing besides mention parsing.

### Mention syntax

`@<id>` where `<id>` is a tool ID, a model ID, a Brain path, a GitHub `owner/repo`, or an alias. Mentions can include `/`, `-`, `.`, and `_`. Trailing punctuation (`. , ; : ! ? ) ] }`) is stripped before lookup.

```text
Find investors with @exa.        ← @exa            (tool)
Use @openai/gpt-5.4 for this.    ← @openai/gpt-5.4 (model)
Run @deep on the summary.        ← @deep           (alias → openai/gpt-5.4)
Read @brain/product/ first.      ← @brain/product/ (Brain folder)
Work in @opencompany/web.        ← @opencompany/web (GitHub repository)
```

### Aliases

Aliases are only recognized inside body mentions — not as raw `model:` values.

| Alias                | Resolves to           |
| -------------------- | --------------------- |
| `@fast`, `@default`  | `openai/gpt-5.4-mini` |
| `@deep`              | `openai/gpt-5.4`      |

Unknown `@text` that doesn't match a model, tool, or alias stays in the body as plain text — no error, no contribution to frontmatter.

## Storage layout

```text
workspace-repo/
└── agents/
    ├── fundraising-copilot.agent
    ├── ops-triage.agent
    └── sales-research.agent
```

One agent per file. The slug must match the filename; the platform regenerates it from the title on every save.

If two agents resolve to the same slug, later ones get a `-2`, `-3`, … suffix (`agents/research.agent`, `agents/research-2.agent`).

### Renames

- **Editor-originated** (changing the title): the new slug is computed at save time, the file is written at the new path, and the old GitHub file is deleted as part of the same sync job (tracked via `previousPath` / `previousBlobSha` on `agent_sync_jobs`).
- **GitHub-originated** (renaming the file directly in the repo): treated as a new agent on the next import, because the workspace sync keys off the file path. Renaming in GitHub will desync until a re-save in the editor reconciles the slug.

## Save behavior

When the editor saves an agent:

1. Postgres receives the title, body, body-derived config, sanitized editor content, content hash, and version — synchronously. This is the "saved" state from the user's perspective.
2. `agent_sync_jobs` is upserted with a `nextRunAt` ~10 seconds out, debouncing rapid edits. If the title change produced a new path, the previous path and blob SHA are recorded on the job so the worker can delete the old GitHub file.
3. `agent.sync_requested` is dispatched to Inngest.
4. Inngest writes the file to GitHub asynchronously.

The editor only waits on step 1. GitHub sync status is surfaced separately and never blocks editing — a failing sync shows on the agent row, not on the save button.

## Validation rules

The parser is intentionally lenient. A hand-edited `.agent` file should never refuse to load.

| Rule                             | Behavior on violation                          |
| -------------------------------- | ---------------------------------------------- |
| Title empty                      | Becomes `"Untitled agent"`                     |
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
model: openai/gpt-5.4-mini
tools: []
---

Summarize whatever I paste below.
```

### With a tool and a deep model

```yaml
---
title: "Investor research"
model: openai/gpt-5.4
tools:
  - exa
---

Find recent fund announcements with @exa. Use @deep to write the brief.
```

### Letting mentions drive everything

Author with only the body. The serializer fills in the frontmatter from the mentions:

```yaml
---
title: "Research"
model: openai/gpt-5.4
tools:
  - exa
---

Find investors with @exa and run a deep pass with @deep.
```

You never touched `model:` or `tools:`. They reflect what the body actually references.

## Compiled config

The runtime consumes a normalized `AgentConfig` (defined in `packages/db/src/schema.ts`):

```ts
{
  schemaVersion: "agent.v1",
  title: "Investor research",
  instructions: "Find recent fund announcements with @exa...",
  model: {
    provider: "vercel-ai-gateway",
    name: "openai/gpt-5.4",
  },
  tools: [
    { id: "exa", type: "tool", label: "exa", description: "Deep research on the web and people." },
  ],
  brain: [
    { path: "docs/README.md", type: "file" },
    { path: "product/", type: "folder" },
  ],
}
```

`schemaVersion: "agent.v1"` is a forward-compatibility hook. New versions will be additive — older files stay readable.

## Where the code lives

- Parser and serializer — `apps/web/lib/agents/agent-file.ts`
- Mention parsing, supported catalogs, and body-derived config — `apps/web/lib/agents/mentions.ts`
- Tiptap preview adapter — `apps/web/lib/agents/config.ts`
- Compiled config type — `packages/db/src/schema.ts` (`AgentConfig`)
- Editor — `apps/web/components/agent-editor/AgentEditor.tsx`
- Save action and GitHub sync — `apps/web/lib/agents/actions.ts`, `apps/web/lib/inngest/functions.ts`

## FAQ

**Can I commit `.agent` files by hand?**
Yes. Push them to the workspace repo and trigger a manual import — the web app reads the format directly. Mentions in the body will be picked up just like edits made in the editor.

**What happens if two saves race?**
Every save carries a content hash and version. Inngest debounces by ~10 seconds and limits one in-flight sync per agent. If GitHub returns a conflicting blob SHA, the sync refetches and retries.

**How do I add a new model or tool?**
Add it to `apps/web/lib/agents/mentions.ts` and ship. Older files that don't reference it are unaffected; clients that don't recognize a new ID will fall back gracefully.

**How do I evolve the format?**
Bump `schemaVersion` in `packages/db/src/schema.ts` and add a normalizer in `parseAgentFile`. Keep additions additive so existing files keep parsing as `agent.v1` until they're re-serialized.
