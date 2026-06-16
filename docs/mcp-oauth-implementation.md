# OpenCompany MCP OAuth Implementation

Date: 2026-06-16

## Product decision

OpenCompany should support two authentication paths for the hosted MCP endpoint:

- Personal bearer tokens for manual setup, scripts, and clients that cannot run OAuth.
- Standard OAuth for clients that can discover, register, and authorize a remote MCP server.

The first OAuth version should be DCR + authorization-code + PKCE. This directly addresses Claude's "couldn't register" error and also gives ChatGPT/Codex/Cursor-style clients the metadata and token flow they expect.

## Implementation plan

- [x] Research MCP, Claude, ChatGPT, and Codex OAuth expectations.
- [x] Add research notes in `docs/mcp-oauth-research.md`.
- [x] Add OAuth persistence tables for clients, authorization codes, and tokens.
- [x] Generate a Drizzle migration.
- [x] Add OAuth discovery metadata endpoints.
- [x] Add Dynamic Client Registration.
- [x] Add authorization-code + PKCE authorization endpoint with a user consent screen.
- [x] Add token endpoint for authorization-code exchange and refresh-token rotation.
- [x] Let the MCP route authenticate either existing personal MCP tokens or new OAuth access tokens.
- [x] Update the MCP `WWW-Authenticate` challenge to advertise protected-resource metadata.
- [x] Run targeted tests.
- [x] Run typecheck.
- [x] Run format check.
- [x] Commit and push the PR branch.

## Files changed

- `packages/db/src/schema.ts`
- `drizzle/0058_concerned_jack_power.sql`
- `drizzle/meta/0058_snapshot.json`
- `drizzle/meta/_journal.json`
- `apps/web/lib/personal/mcp-oauth.ts`
- `apps/web/lib/personal/mcp-auth.ts`
- `apps/web/app/.well-known/oauth-protected-resource/route.ts`
- `apps/web/app/.well-known/oauth-protected-resource/api/mcp/opencompany/route.ts`
- `apps/web/app/.well-known/oauth-authorization-server/route.ts`
- `apps/web/app/api/oauth/register/route.ts`
- `apps/web/app/api/oauth/authorize/route.ts`
- `apps/web/app/api/oauth/token/route.ts`
- `apps/web/app/api/mcp/opencompany/route.ts`
- `apps/web/app/api/mcp/opencompany/route.test.ts`

## Current behavior

Unauthenticated MCP calls receive a `401` with a `WWW-Authenticate` challenge pointing to `/.well-known/oauth-protected-resource`.

Clients can register dynamically at `/api/oauth/register` with public-client metadata and redirect URIs. The server returns a generated `client_id`.

Clients start OAuth at `/api/oauth/authorize`. OpenCompany validates the client, redirect URI, resource, scope, and PKCE challenge. The signed-in user sees a consent page. On approval, OpenCompany issues a one-time authorization code and redirects back to the client.

Clients exchange the code at `/api/oauth/token` with `client_id`, `redirect_uri`, `code_verifier`, and `resource`. OpenCompany stores hashed opaque tokens and returns an access token plus refresh token.

The MCP route accepts either an existing `oc_mcp_...` personal token or an OAuth access token. OAuth access tokens must be unexpired, unrevoked, scoped with `mcp:read`, and bound to the OpenCompany MCP resource.

## Follow-up

CIMD should be the next interoperability improvement for ChatGPT at scale. It requires fetching and validating client metadata document URLs and then advertising `client_id_metadata_document_supported: true`.
