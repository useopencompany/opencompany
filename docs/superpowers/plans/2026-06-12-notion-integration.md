# Notion Integration Plan

Date: 2026-06-12

## Strategy

Ship Notion as an MCP-first integration.

The v1 success condition is that an admin can connect Notion through workspace settings or the personal integrations flow, add `@notion` to an agent, and the runner can discover and execute Notion MCP tools through the existing `{provider}__search_tools` / `{provider}__use_tool` pattern.

No schema migration is needed for v1 because Notion fits the existing `workspace_mcp_servers` and `workspace_mcp_credentials` model.

## Implementation Checklist

- [x] Research existing OpenCompany integration architecture.
- [x] Research current Notion MCP and REST/OAuth docs.
- [x] Decide MCP-first for v1.
- [x] Add Notion MCP provider constants and settings state.
- [x] Add Notion OAuth provider and `/api/mcp/notion/start|callback` routes.
- [x] Add Notion MCP upsert/remove actions.
- [x] Add Notion to runner MCP provider catalog.
- [x] Add `notion` to the agent runtime tool catalog and docs.
- [x] Add Notion to agent editor and personal integration UI catalogs.
- [x] Add Notion connection state to personal layout/details.
- [x] Update tests for MCP data, OAuth providers, runner MCP, and tool parsing where needed.
- [x] Run focused verification.

## Files Expected To Change

- `apps/web/lib/mcp/data.ts`
- `apps/web/lib/mcp/actions.ts`
- `apps/web/lib/mcp/oauth-providers.ts`
- `apps/web/app/api/mcp/notion/start/route.ts`
- `apps/web/app/api/mcp/notion/callback/route.ts`
- `apps/runner/src/mcp-tools.ts`
- `packages/agent-runtime/src/tools.ts`
- `packages/agent-runtime/src/types.ts`
- `apps/web/components/agent-editor/tools.ts`
- `apps/web/lib/personal/actions.ts`
- `apps/web/lib/personal/integrations-catalog.ts`
- `apps/web/app/personal/layout.tsx`
- `apps/web/lib/personal/integration-details*.ts`
- `docs/agent-file.md`
- `docs/stack/ai-and-agent-runtime.md`
- Focused tests beside touched modules

## Product Behavior

Workspace settings:

- Notion appears as an MCP-backed integration if the company settings UI is extended in this slice. If the current company settings UI only handles first-party integrations, Notion still ships through the personal integrations catalog and OAuth route.

Personal integrations:

- Notion appears in the integrations list.
- Connect opens `/api/mcp/notion/start?returnTo=/onboarding/connected`.
- Add integration appends `@notion` to the personal agent body.
- Connection status is based on `mcpSettings.notion.configured`.

Agent runtime:

- `@notion` serializes to:

```yaml
tools:
  - id: notion
    type: mcp
    server: notion
```

- A configured Notion workspace exposes `notion__search_tools` and `notion__use_tool`.
- An unconfigured Notion workspace exposes a safe connection-status stub.

## Risks

- Notion MCP tool schemas are remote and may change. Mitigation: use the existing discovery/meta-tool approach instead of hardcoding raw Notion tools.
- Notion recommends SSE fallback if Streamable HTTP fails. Mitigation: start with the recommended `/mcp` endpoint; add fallback only if field testing shows client compatibility issues.
- Permission policy is generic at the MCP meta-tool layer. Mitigation: v1 uses existing MCP approval controls; raw-tool-aware policy can be a follow-up.

## Verification Plan

- Run focused unit tests:
  - `bun test apps/web/lib/mcp/oauth-providers.test.ts`
  - `bun test apps/web/lib/mcp/data.test.ts`
  - `bun test apps/runner/src/mcp-tools.test.ts`
  - `bun test apps/web/components/agent-editor/tools.test.ts`
- Run a typecheck if time permits:
  - `bun run typecheck`
- Manual OAuth verification requires live Notion and app callback URLs, so it may remain documented but unverified locally.

## Implementation Log

- 2026-06-12: Research completed. Chose MCP-first because Notion has an official hosted MCP server compatible with OpenCompany's existing dynamic MCP OAuth stack.
- 2026-06-12: Implemented Notion MCP provider constants, OAuth routes, settings and personal UI wiring, runner catalog support, agent runtime `@notion` support, permission policy metadata, and focused tests.
- 2026-06-12: Verification passed: focused web/runner/agent-runtime tests, `bun run typecheck`, `bun run format:check`, and `git diff --check`.
