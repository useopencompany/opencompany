# The `.agent` File Format

An agent is a single plain-text file with YAML frontmatter and a Markdown body. The frontmatter is
the product contract for runtime configuration; the body is the model-facing instruction document.

This repo is pre-release, so the current supported `.agent` file version is `2`. There is no
version `1` compatibility requirement.

## Example

```yaml
---
version: 2
title: "AMP code agent"
model: openai/gpt-5.4
tools:
  - id: amp
    type: coding_agent
    provider: amp
    repository: web-app
    prCapable: true
  - id: exa
    type: hosted_tool
integrations:
  github:
    repositories:
      - id: web-app
        fullName: opencompany/opencompany
        defaultBranch: main
triggers:
  - id: pr-work
    type: github.pull_request
    repository: web-app
    events: [opened, reopened, synchronize, ready_for_review]
    branches: [main]
    enabled: false
---

Use @amp for code changes in @opencompany/opencompany. Open draft PRs when the task is ready for review.
```

## Frontmatter Fields

| Field | Required | Description |
| --- | --- | --- |
| `version` | yes | Must be `2`. |
| `title` | yes | Human-readable name. Empty values normalize to `Untitled agent`. |
| `model` | yes | Model ID routed through Vercel AI Gateway. Unknown values fall back to `openai/gpt-5.4-mini`. |
| `tools` | yes | Structured callable capabilities available to the agent. |
| `integrations` | yes | Connected external resources the tools/triggers can reference. |
| `triggers` | yes | Event entrypoints. PR triggers are persisted in V1 but execution remains disabled. |

The distinction is intentional: a tool is a callable runtime capability, while an integration is a
workspace-level external resource or authority boundary. Platform provider credentials can power
tools, but they are not integrations unless they grant access to user-owned resources.

Supported models:

| ID | Notes |
| --- | --- |
| `openai/gpt-5.4-mini` | Default fast model. |
| `openai/gpt-5.4` | Deeper GPT model for complex work. |
| `anthropic/claude-haiku-4.5` | Fast Claude model. |
| `anthropic/claude-sonnet-4.6` | Claude model for coding-heavy work. |

## Tools

`tools` is a list of objects. A tool is a capability the model can call at runtime. Provider-backed
tools still belong here; their credentials are stored outside the `.agent` file.

### Exa

```yaml
tools:
  - id: exa
    type: hosted_tool
```

Enables `exa_search`, `web_fetch`, and `tool_help` in the runner.

### AMP

```yaml
tools:
  - id: amp
    type: coding_agent
    provider: amp
    repository: web-app
    prCapable: true
```

Enables `amp_coder` in the runner. AMP is an agent tool, not a workspace integration. The
`repository` value must match an `integrations.github.repositories[*].id` because GitHub is the
connected resource AMP works against. If it does not, the parser keeps AMP but sets `repository:
null`, and the runner does not expose `amp_coder` until a valid repo is bound.

`prCapable: true` allows generated-branch + draft-PR creation. It does not allow direct pushes to
the repository default branch.

## Integrations

Integrations describe connected external resources agents can access. For GitHub:

```yaml
integrations:
  github:
    repositories:
      - id: web-app
        fullName: opencompany/opencompany
        defaultBranch: main
```

`id` is the local handle used by tools and triggers. `fullName` is the GitHub `owner/repo`.
`defaultBranch` is the branch PR triggers watch and draft PRs target.

The app stores `.agent` files in an OpenCompany-managed workspace backing repo. GitHub repositories
listed here are work integration repositories that agents operate on; they are intentionally
separate from the managed workspace backing repo.

AMP does not appear under `integrations` because enabling `@amp` changes what the agent can do, not
which user-owned resource it can access. The runner uses OpenCompany's platform AMP credential only
when the AMP tool runs.

## Triggers

V1 persists trigger config but does not execute webhook-triggered sessions yet.

```yaml
triggers:
  - id: pr-work
    type: github.pull_request
    repository: web-app
    events: [opened, reopened, synchronize, ready_for_review]
    branches: [main]
    enabled: false
```

Supported trigger type: `github.pull_request`.

Supported events: `opened`, `reopened`, `synchronize`, `ready_for_review`.

`repository` must reference a configured GitHub repository id. Invalid trigger rows are dropped.

## Body And Mentions

The body is Markdown and is passed to the model as instructions. In the web editor, rich mention
nodes like `@amp`, `@exa`, or an explicit GitHub work repository mention such as
`@opencompany/opencompany` are the authored source for selected tools and integrations. The server
derives structured frontmatter from those mention nodes on save, then downstream runtime code reads
the normalized frontmatter.

Use the Add Mention menu to insert supported tool and integration mentions. For AMP, mention both
`@amp` and the GitHub work repository it should use. Removing a supported mention from the body
removes its derived frontmatter config on the next save.

Model aliases still help the editor: `@fast` and `@default` map to `openai/gpt-5.4-mini`, and
`@deep` maps to `openai/gpt-5.4`.

## Parser Rules

The parser is lenient so hand-edited files keep loading:

| Bad input | Behavior |
| --- | --- |
| Missing or invalid frontmatter | Defaults are applied. |
| Empty title | Normalizes to `Untitled agent`. |
| Unknown model | Falls back to `openai/gpt-5.4-mini`. |
| Unknown tool | Dropped. |
| Invalid GitHub repo full name | Dropped. |
| Tool references missing repo | Tool is kept with `repository: null`; runtime use fails clearly. |
| Trigger references missing repo | Trigger is dropped. |
| `\r\n` line endings | Normalized to `\n`. |

## Code Ownership

- Parser and serializer: `apps/web/lib/agents/agent-file.ts`
- Builder catalog and mentions: `apps/web/lib/agents/config.ts`, `apps/web/components/agent-editor`
- Shared config type: `packages/db/src/schema.ts`
- Runtime tool resolution: `packages/agent-runtime/src/tools.ts`
- AMP execution: `apps/runner/src/agent-loop.ts`
