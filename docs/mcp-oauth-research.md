# OpenCompany MCP OAuth Research

Date: 2026-06-16

## Goal

OpenCompany's remote MCP server should connect cleanly from hosted and local MCP clients such as Claude, ChatGPT, Codex, Cursor, and other OAuth-capable agent tools. The implementation should keep our existing personal bearer tokens for manual/developer use, while adding the standard OAuth discovery and authorization flow expected by modern MCP clients.

## What clients expect

The MCP authorization spec treats a protected MCP server as an OAuth 2.1 resource server. The MCP server must expose OAuth Protected Resource Metadata and point clients to an authorization server. The authorization server must expose OAuth Authorization Server Metadata. Clients then use authorization-code with PKCE, and authorization servers/clients should support Dynamic Client Registration (DCR).

Source: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

Key requirements from the MCP spec:

- The MCP server must publish Protected Resource Metadata with `authorization_servers`.
- The authorization server must publish metadata with endpoints and supported capabilities.
- Clients use `Authorization: Bearer <token>` for MCP calls.
- Clients include a `resource` parameter in authorization and token requests.
- Servers validate that an access token was minted for the MCP server resource.
- PKCE is required for public clients.
- DCR is strongly recommended because generic clients cannot know every MCP server in advance.

OpenAI's ChatGPT Apps SDK guidance matches this shape. ChatGPT queries protected resource metadata, discovers OAuth metadata, identifies/registers itself using CIMD, DCR, or predefined credentials, runs authorization-code + PKCE, and then attaches the resulting bearer token to MCP requests.

Source: https://developers.openai.com/apps-sdk/build/auth

Codex also has a native MCP OAuth login path. It prefers server-advertised `scopes_supported` during OAuth login, which means our metadata should advertise the smallest useful scope rather than relying on client config.

Source: https://developers.openai.com/codex/mcp

Claude Code documents the same failure mode we saw: if a server does not support automatic OAuth setup through DCR, users must manually enter preconfigured client credentials. It also supports fixed localhost callback ports and CIMD.

Source: https://code.claude.com/docs/en/mcp

Claude's API MCP connector supports OAuth bearer tokens for authenticated servers. That covers API-side usage where the caller already has a token, but does not remove the need for proper discovery and token issuance for end-user client setup.

Source: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

## Direction

Implement a small OpenCompany-owned OAuth authorization server for the OpenCompany MCP endpoint:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /api/oauth/register`
- `GET /api/oauth/authorize`
- `POST /api/oauth/token`

Use opaque, hashed database tokens instead of JWTs for the first version. That fits our current personal token model, avoids key management/JWKS work, and lets the MCP route validate audience, scope, expiry, revocation, user, and workspace from the database.

Support DCR now. Do not require client secrets for DCR clients; use public-client authorization-code with PKCE `S256`. This matches Claude/Codex local callback flows and ChatGPT DCR flows.

Keep CIMD as a next step. ChatGPT prefers CIMD at scale because the client identity can be a stable metadata document URL and avoids creating many per-instance DCR clients. We should support CIMD after DCR is live by accepting URL-shaped `client_id` values, fetching/validating metadata documents, and advertising `client_id_metadata_document_supported: true`.

## Security constraints

- Exact redirect URI matching is required.
- DCR redirect URIs must be HTTPS, except localhost/loopback HTTP for local clients.
- PKCE `S256` is required for code exchange.
- Access tokens are short-lived.
- Refresh tokens rotate.
- OAuth tokens are bound to `https://<app>/api/mcp/opencompany` via the `resource` value.
- The MCP server still challenges unauthenticated requests with `WWW-Authenticate` and the protected-resource metadata URL.
- The human user must already be signed into OpenCompany and approve a consent screen before an authorization code is issued.

## Non-goals for this pass

- Replacing WorkOS as the user login system.
- Adding write scopes.
- Adding third-party developer portal UI for manual client creation.
- Adding JWT access tokens or JWKS.
- Advertising CIMD before we validate CIMD documents correctly.
