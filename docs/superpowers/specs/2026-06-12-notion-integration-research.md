# Notion Integration Research

Date: 2026-06-12

## Decision

Start with a Notion MCP integration, not a bespoke first-party REST integration.

The first product job is to let OpenCompany agents search, read, create, and update Notion content during a run. Notion now provides an official hosted MCP server at `https://mcp.notion.com/mcp` with OAuth 2.0 Authorization Code + PKCE, token refresh, and dynamic client registration. That matches OpenCompany's existing MCP stack for Linear, PostHog, Better Stack, and Braintrust. A first-party REST integration should come later only if the product needs OpenCompany-owned Notion data modeling: resource selection in our UI, background sync, cached search/indexing, webhooks, or workflows that need exact Notion page/database semantics outside a live agent run.

## Sources

- Notion MCP overview: https://developers.notion.com/guides/mcp/overview
- Notion custom MCP client guide: https://developers.notion.com/guides/mcp/build-mcp-client
- Notion MCP supported tools: https://developers.notion.com/guides/mcp/mcp-supported-tools
- Notion public connections: https://developers.notion.com/guides/get-started/public-connections
- Notion OAuth authorization: https://developers.notion.com/guides/get-started/authorization
- Notion bearer-token authentication: https://developers.notion.com/reference/authentication
- Notion API key handling: https://developers.notion.com/guides/get-started/handling-api-keys
- OpenCompany agent file contract: `docs/agent-file.md`
- OpenCompany runtime stack notes: `docs/stack/ai-and-agent-runtime.md`
- Existing MCP web wiring: `apps/web/lib/mcp/*`
- Existing MCP runner wiring: `apps/runner/src/mcp-tools.ts`

## Existing OpenCompany Architecture

OpenCompany already has two integration lanes:

1. `workspace_integrations`
   - Used for product-owned integrations such as GitHub, Neon, Gmail, and Google Calendar.
   - Stores provider connection rows, selected resources, status, and encrypted credentials.
   - Best fit when OpenCompany needs to list/select/sync provider resources, implement custom hosted tools, or show provider-specific UX.

2. `workspace_mcp_servers`
   - Used for agent-accessible MCP providers such as Linear, Slack, PostHog, Better Stack, and Braintrust.
   - Stores one server row per workspace/provider plus encrypted OAuth credentials in `workspace_mcp_credentials`.
   - The `.agent` file only records the MCP tool binding, e.g. `tools: [{ id: "linear", type: "mcp", server: "linear" }]`.
   - The runner discovers tools from the remote MCP server at run time and exposes two meta-tools per provider: `{provider}__search_tools` and `{provider}__use_tool`.
   - If a configured agent mentions an MCP integration before the workspace connects it, the runner registers a read-only connection-status stub instead of failing the whole run.

This means Notion can be added without schema changes if we follow the MCP lane:

- Add provider constants in `apps/web/lib/mcp/data.ts`.
- Add a provider entry in `apps/web/lib/mcp/oauth-providers.ts`.
- Add start/callback route files under `apps/web/app/api/mcp/notion/`.
- Add upsert/remove helpers in `apps/web/lib/mcp/actions.ts`.
- Include Notion in `loadWorkspaceMcpSettingsForWorkspace`.
- Add Notion to `apps/runner/src/mcp-tools.ts`.
- Add `notion` as an agent tool in `packages/agent-runtime/src/tools.ts` and related type/icon/UI catalogs.
- Update `docs/agent-file.md` and runtime docs.

## Notion Capabilities

Notion's hosted MCP server is official and built for AI agent clients. It supports Streamable HTTP at `https://mcp.notion.com/mcp` and SSE at `https://mcp.notion.com/sse`; Notion recommends Streamable HTTP first. The existing `@ai-sdk/mcp` client path uses HTTP transports and is already compatible with the route used by other OpenCompany providers.

Notion's MCP docs list tools for:

- Searching Notion and connected sources.
- Fetching Notion content.
- Creating pages.
- Updating pages.
- Moving pages.
- Creating comments.
- Getting comments.
- Getting teamspaces.
- Listing users.
- Getting current user and bot/workspace information.

Notion MCP rate limits use the standard Notion API limit of roughly 180 requests per minute per user, with stricter limits for some tools. Search is currently listed as 30 requests per minute.

Notion public API OAuth is still valuable, but it is not the best v1 fit for agent tool access. Public connections act on behalf of the individual authorizing user, use a page picker, and return bearer tokens for REST API calls. Building directly on REST would force OpenCompany to own a Notion-specific tool surface, block/page/databases mapping, pagination, rate-limit behavior, and agent-optimized formatting. The official MCP server already provides that tool surface.

## MCP Route Vs First-Party Route

### MCP-first benefits

- Fastest path to useful agent capability because Notion owns tool definitions and payload formatting.
- No new database schema for v1.
- No new secret env vars if dynamic client registration works as documented.
- Reuses existing OAuth state signing, encrypted credential storage, runner token refresh, setup UI, and not-connected stub behavior.
- Keeps Notion credentials out of `.agent` files and out of client-side code.
- Keeps OpenCompany aligned with the product's agent-tool model: mentioning `@notion` enables the provider for that agent.

### MCP-first limitations

- OpenCompany does not get a normalized list of user-selected Notion pages/databases.
- Per-resource selection happens in Notion's authorization flow and Notion's own permissions model, not in our UI.
- Tool names, schemas, and behavior are controlled by Notion and can change over time.
- Fine-grained policy in OpenCompany can gate `notion__use_tool`, but it cannot classify every Notion raw tool perfectly unless we add raw-tool-aware MCP policy later.
- The runner currently only tries the configured endpoint. It does not implement Notion's suggested `/mcp` to `/sse` fallback. This is acceptable for v1 because `/mcp` is the recommended transport.

### First-party benefits

- Product-owned page/database selection, labels, and status.
- Custom hosted tools with predictable schemas, permission groups, and approval UX.
- Background sync, cached search, embeddings, and workspace memory ingestion.
- Easier product analytics on exact Notion resource usage.
- Better fit for features where Notion is a durable data source rather than an agent tool.

### First-party costs

- Requires Notion public connection setup, client ID/secret env vars, and callback handling.
- Requires new provider-specific sync/service modules and likely resource tables or resource rows.
- Requires designing a tool API for pages, databases, blocks, comments, and search.
- Requires ongoing maintenance as Notion API versions and object schemas evolve.
- Duplicates agent-focused work Notion already ships through hosted MCP.

## Recommendation

Implement Notion MCP first as the v1 integration.

Treat this as a workspace MCP provider with dynamic client registration:

- Provider key: `notion`
- Display name: `Notion`
- Endpoint: `https://mcp.notion.com/mcp`
- Credential kind: `oauth`
- Agent mention: `@notion`
- Personal integration row: Notion, kind `mcp`, connection URL `/api/mcp/notion/start`

Do not add a Notion REST public connection in this slice. Put that behind a later product decision when we need one of these explicit capabilities:

- Notion page/database resource picker inside OpenCompany.
- Workspace-level Notion sync or indexing.
- Durable Notion knowledge in Brain/memory.
- Notion webhooks.
- Notion-specific approval categories beyond generic MCP read/use gates.

## Security And Reliability Notes

- Use the existing encrypted MCP credential store. Notion access and refresh tokens must never appear in `.agent` files, logs, client props, or markdown docs.
- Keep OAuth state session-bound and workspace-bound through the existing HMAC state helper.
- Use the standard runner not-connected stub when `@notion` is enabled but credentials are absent.
- Document Notion's rate limits and avoid any v1 background polling.
- Use existing MCP dynamic-client tests to cover Notion as a dynamic provider.
