# Agent MCP

OpenCompany supports local agent MCP configuration for Conductor workspaces, Claude Code, and Codex.
The current project-level MCP server is SigNoz Cloud.

Conductor does not use a separate MCP format. Claude Code reads `.mcp.json` from the repository root,
and Codex reads `.codex/config.toml` for trusted projects. Those files are generated locally and
gitignored because MCP auth can create machine-specific credentials.

## Configure SigNoz

Set one of these local env vars in `.env.override.local` or `.env.local`:

```sh
SIGNOZ_MCP_REGION="eu2"
# or:
SIGNOZ_MCP_URL="https://mcp.eu2.signoz.cloud/mcp"
```

If neither value is set, `bun run mcp:configure` tries to infer the region from
`GOAT_OTEL_EXPORTER_OTLP_ENDPOINT`, for example `https://ingest.eu2.signoz.cloud:443`.

Then run:

```sh
bun run mcp:configure
```

The command writes:

- `.mcp.json` for Claude Code
- `.codex/config.toml` for Codex

Conductor workspace setup also runs this command after `bun install`, so new workspaces pick up the
config automatically when the env is present. In Conductor workspaces, the command also checks the
root checkout named by `CONDUCTOR_ROOT_PATH` for only these MCP-related env keys, so you do not need
to copy the full `.env.local` into every worktree.

## Authenticate

Codex:

```sh
codex mcp login signoz
```

Then run `/mcp` inside Codex and confirm `signoz` is connected.

Claude Code:

Start Claude Code, run `/mcp`, select `signoz`, and complete the browser authentication flow.

Do not commit header-based SigNoz API keys or generated MCP auth state. SigNoz Cloud's hosted MCP
server supports OAuth; use that flow unless a client cannot authenticate interactively.
