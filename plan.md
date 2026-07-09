# Goat: Minimal per-brain MCP server (OAuth via WorkOS AuthKit) with a single `query_brain` tool

## Context

Goat brains (`apps/goat`) hold knowledge documents that today are only reachable through the Goat UI/chat. We want to expose a given brain to Claude web (Settings → Connectors → Add custom connector) via a very basic first MCP server offering exactly one tool: query the brain. Nothing else — no writes.

Auth is **OAuth via WorkOS AuthKit**, not a secret URL: Goat already uses AuthKit for sign-in, and AuthKit can act as the OAuth authorization server for MCP servers (per [WorkOS AuthKit MCP docs](https://workos.com/docs/authkit/mcp)). The connect UX in Claude becomes: paste URL → click Connect → sign in with your existing Goat account → done. Access is enforced per real user via the existing brain-access rules, and **no new DB table or migration is needed**.

## Research findings that shape the design

- **Claude web custom connectors** speak Streamable HTTP MCP and support OAuth with dynamic client registration. The flow: Claude gets a 401 with a `WWW-Authenticate` header → fetches `/.well-known/oauth-protected-resource` → discovers AuthKit as the authorization server → registers itself (CIMD/DCR) → user signs in via AuthKit → Claude sends `Authorization: Bearer <JWT>` on every MCP request.
- **AuthKit as authorization server** requires only: (a) one-time WorkOS Dashboard toggles — enable **Client ID Metadata Documents (CIMD)** and **Dynamic Client Registration** under *Connect → Configuration* on the Goat WorkOS environment; (b) our server serving protected-resource metadata; (c) our server verifying JWTs against AuthKit's JWKS (`https://<authkit_domain>/oauth2/jwks`, issuer = the AuthKit domain).
- **Resource Indicators are optional**: with none configured, AuthKit issues tokens with a default environment-wide `aud` and ignores the `resource` param ([changelog](https://workos.com/changelog/resource-indicators-for-mcp-auth)). So per-brain URLs need no wildcard registration in v1; we verify issuer + signature + expiry and skip audience validation (hardening follow-up below).
- The access token's `sub` is the **WorkOS user id** — exactly the key used by `requireGoatBrainAccess({ userWorkosId, brainRef })` / `getGoatBrainAccess` in `packages/db/src/goat-workspaces.ts`. Brain access = workspace membership or `brain_members` row; revoking membership revokes MCP access automatically.
- **No MCP *server* infrastructure exists in the repo** — `apps/web/lib/mcp/*` is client-side only. Use the `mcp-handler` package (Vercel's Next.js MCP adapter). Streamable HTTP works stateless without Redis; it also ships auth helpers (`withMcpAuth`, `protectedResourceHandler`, `metadataCorsOptionsRequestHandler`) — verify exact export names against the mcp-handler README at implementation time; hand-rolling the metadata JSON + jose verify is a trivial fallback.
- **A read-only query path already exists and is reused as-is**: `runGoatBrainToolForUser()` in `apps/goat/lib/brain-cli.ts` with `{ command: "query", flags: { text, folder, limit, json: true } }`. `query` is in `READ_ONLY_GOAT_BRAIN_COMMANDS` (no DB write-back) and every run is traced to `goat.brain_tool_runs`. It needs `gatewayApiKey` (`process.env.VERCEL_AI_GATEWAY_API_KEY`, same as `apps/goat/app/api/chat/route.ts:83`) and a `userWorkosId` — here, the authenticated OAuth user.
- `/api/mcp` and `/.well-known` are unused in `apps/goat/app/` — no route conflicts. `apps/goat/package.json` has `@workos-inc/authkit-nextjs` + `@workos-inc/node` but **no `zod`, `jose`, or `mcp-handler`** — those get added. The AuthKit domain is not referenced anywhere in code yet → new env var.

## Implementation

### 0. One-time config (manual, outside code)

- WorkOS Dashboard (Goat environment): enable **CIMD** and **Dynamic Client Registration** under *Connect → Configuration*. Do NOT add Resource Indicators for v1.
- New env var `GOAT_AUTHKIT_DOMAIN` (e.g. `https://<env>.authkit.app` or the custom auth domain) — add to local `.env`, Vercel preview + prod for the goat app, and any env docs the repo keeps.

### 1. Dependencies

`apps/goat/package.json`: add `mcp-handler`, `jose`, `zod`.

### 2. OAuth discovery metadata routes

- `apps/goat/app/.well-known/oauth-protected-resource/[[...path]]/route.ts` — RFC 9728 metadata. Catch-all because clients fetch the path-suffixed form (`/.well-known/oauth-protected-resource/api/mcp/<brainId>/mcp`). Returns:
  ```json
  {
    "resource": "<origin>/<path-after-well-known-prefix>",
    "authorization_servers": ["<GOAT_AUTHKIT_DOMAIN>"],
    "bearer_methods_supported": ["header"]
  }
  ```
  Plus `OPTIONS` CORS handling (use mcp-handler's `protectedResourceHandler`/`metadataCorsOptionsRequestHandler` if they fit).
- `apps/goat/app/.well-known/oauth-authorization-server/route.ts` — compatibility for older clients: proxy `${GOAT_AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`.

### 3. MCP endpoint: `apps/goat/app/api/mcp/[brainId]/[transport]/route.ts`

`brainId` is the non-secret `goat.brains.id`. Per-request flow:

1. **Verify bearer token** with `jose`: `createRemoteJWKSet(new URL(\`${authkitDomain}/oauth2/jwks\`))`, `jwtVerify(token, jwks, { issuer: authkitDomain })` (module-level JWKS instance so keys are cached). Missing/invalid token → 401 with `WWW-Authenticate: Bearer ... resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp/<brainId>/mcp"` — this header is what triggers Claude's OAuth flow. mcp-handler's `withMcpAuth(handler, verifyToken, { required: true, resourceMetadataPath })` wraps exactly this.
2. **Authorize**: `payload.sub` → `userWorkosId`; `getGoatBrainAccess({ userWorkosId, brainRef: brainId })` → 403/404 if no access.
3. **Serve MCP** via `createMcpHandler` (constructed per request so `basePath: \`/api/mcp/${brainId}\`` works), registering the single tool:
   ```ts
   server.tool(
     "query_brain",
     `Search the "${brain.name}" knowledge brain (people, companies, projects, decisions, notes)...`,
     { text: z.string(), folder: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
     async ({ text, folder, limit }) => {
       const output = await runGoatBrainToolForUser({
         brainRef: brainId,
         userWorkosId,            // the authenticated OAuth user — runs are attributed to them
         toolInput: { command: "query", flags: { text, ...(folder ? { folder } : {}), limit: limit ?? 10, json: true } },
         gatewayApiKey,           // process.env.VERCEL_AI_GATEWAY_API_KEY, 500 if missing (mirror chat route)
         sourceRef: `mcp:${brainId}`,
       });
       const body = output.parsed ? JSON.stringify(output.parsed, null, 2) : output.stdout;
       return { content: [{ type: "text", text: output.ok ? body : `Query failed: ${output.error}` }], isError: !output.ok };
     },
   );
   ```
4. `export const runtime = "nodejs"; export const maxDuration = 120;` (CLI query itself times out at 60s). Export the wrapped handler as `GET`, `POST`, `DELETE`.

Read-only exposure is enforced structurally: only this one tool is registered, and `query` is in the CLI's read-only set.

### 4. Minimal UI

Add a "Connect to Claude" block to the existing brain access dialog in `apps/goat/components/GoatBrainSwitcher.tsx` (the component already using `getGoatBrainAccessDetailsAction`): a copyable URL `https://<host>/api/mcp/<brainId>/mcp` plus a one-line hint ("Claude → Settings → Connectors → Add custom connector, then sign in with your Goat account"). The URL is non-secret and constructible client-side from the brain id — **no server actions, no state, no dialogs**.

## Files touched (summary)

- `apps/goat/app/api/mcp/[brainId]/[transport]/route.ts` (new)
- `apps/goat/app/.well-known/oauth-protected-resource/[[...path]]/route.ts` (new)
- `apps/goat/app/.well-known/oauth-authorization-server/route.ts` (new)
- `apps/goat/components/GoatBrainSwitcher.tsx` — "Connect to Claude" block in the access dialog
- `apps/goat/package.json` — add `mcp-handler`, `jose`, `zod`
- Env docs/config — `GOAT_AUTHKIT_DOMAIN`

No DB schema changes, no migration.

## Security notes

- Real per-user identity on every call: JWT signature/expiry/issuer verified against AuthKit JWKS; brain access re-checked per request with the existing canonical predicate; runs traced in `goat.brain_tool_runs` with `sourceRef: mcp:*`.
- v1 skips audience validation (WorkOS default env-wide `aud` when no Resource Indicators are configured). Hardening follow-up: register the MCP base URL as a Resource Indicator and validate `aud`.
- No rate limiting in v1; the CLI's 60s timeout and single read-only tool bound the blast radius.

## Verification

1. Dev: set `GOAT_AUTHKIT_DOMAIN`, enable CIMD + DCR on the Goat WorkOS staging environment.
2. Protocol + OAuth smoke test without Claude: `npx @modelcontextprotocol/inspector` → `http://localhost:<port>/api/mcp/<brainId>/mcp` — the inspector drives the full OAuth discovery/DCR/sign-in flow, then `tools/list` + `tools/call query_brain {text:"..."}` should return query results.
3. Negative tests: no bearer token → 401 with `WWW-Authenticate` header pointing at the resource metadata; token for a user without brain access → 403; unknown brain id → 404.
4. Claude web end-to-end needs a public URL → verify on the preview deploy (preview env needs the env var + dashboard toggles too).
5. `bun run format` (biome is the CI gate) + typecheck/lint before pushing.
