# Team MCP Reference Guide

Date: 2026-06-26

## Purpose

This guide is a technical reference for building Connector's team MCP layer. The
target product direction is: a workspace can expose one team MCP endpoint to
agents, while every workspace member gets their own upstream authorization,
connection state, and policy context.

This is research and architecture guidance only. It does not change Connector's
schema, runtime, OAuth routes, or policy model.

## Sources

- MCP specification, latest published version: https://modelcontextprotocol.io/specification/2025-11-25
- MCP architecture overview: https://modelcontextprotocol.io/docs/learn/architecture
- MCP transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP security best practices: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- MCP client best practices: https://modelcontextprotocol.io/docs/develop/clients/client-best-practices
- AI SDK MCP client docs: https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
- Executor MCP proxy docs: https://executor.sh/docs/mcp-proxy
- Claude MCP connector docs: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
- VS Code MCP server docs: https://code.visualstudio.com/docs/agent-customization/mcp-servers
- VS Code MCP developer guide: https://code.visualstudio.com/api/extension-guides/ai/mcp
- OpenAI MCP and Connectors docs: https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- OpenAI Apps SDK MCP docs: https://developers.openai.com/apps-sdk/concepts/mcp-server
- OAuth Dynamic Client Registration, RFC 7591: https://datatracker.ietf.org/doc/html/rfc7591
- OAuth Authorization Server Metadata, RFC 8414: https://datatracker.ietf.org/doc/html/rfc8414
- OAuth Protected Resource Metadata, RFC 9728: https://datatracker.ietf.org/doc/html/rfc9728
- OAuth Resource Indicators, RFC 8707: https://datatracker.ietf.org/doc/html/rfc8707

## Mental Model

MCP is a standard protocol for connecting AI applications to external systems.
It standardizes how an AI host discovers tools, calls tools, reads resources,
retrieves prompt templates, negotiates capabilities, and handles transport-level
authorization.

The core participants are:

- MCP host: the AI application or agent environment, such as Codex, Claude,
  ChatGPT, VS Code, Cursor, or Connector if Connector embeds an agent runtime.
- MCP client: the component inside the host that maintains one connection to one
  MCP server.
- MCP server: the service that exposes tools, resources, prompts, and optional
  client-facing requests.

One host commonly creates many MCP clients, one per configured server. For the
team MCP design, Connector should invert the user's client setup burden: agents
connect to Connector once, and Connector connects onward to many upstream MCP
servers.

## Protocol Basics

MCP uses JSON-RPC 2.0 messages. Requests include an `id`, a `method`, and
optional `params`; responses correlate to the request `id`; notifications omit
`id` and do not expect a response.

The connection starts with lifecycle negotiation:

- The client sends `initialize` with a protocol version, client information, and
  client capabilities.
- The server replies with its protocol version, server information, and server
  capabilities.
- The client sends `notifications/initialized` when it is ready.

Capabilities tell each side what it can safely use. Examples:

- `tools`: server can list and call tools.
- `resources`: server can list and read contextual data.
- `prompts`: server can list and return prompt templates.
- `elicitation`: client can receive structured user-input requests.
- `sampling`: client can run model completions at the server's request, where
  supported and explicitly authorized.

The three server primitives matter differently in product UX:

- Tools are model-controlled executable functions. The model can decide to call
  them when the user request maps to the tool description and schema.
- Resources are application-controlled context. The host usually decides when
  and how to attach them.
- Prompts are user-controlled templates. Clients often expose them as commands
  or reusable workflows.

MCP tool discovery is dynamic. A client calls `tools/list` to get tool metadata:
tool name, title, description, input schema, optional output schema, icons, and
annotations. A client calls `tools/call` with the exact tool name and arguments.
Servers that declare `listChanged` can send
`notifications/tools/list_changed`, after which the client should refresh its
tool catalog.

For Connector, dynamic discovery implies that upstream raw tool catalogs are not
stable product APIs. Tool names, schemas, descriptions, annotations, and
availability can change without an OpenCompany deploy. Team MCP should store
policy and audit records defensively, using provider, connection, raw tool name,
schema hash when useful, and captured call metadata rather than assuming a
permanent local type for every upstream action.

## Transports

MCP defines two standard transports in the current spec.

`stdio` runs a local server subprocess:

- The MCP client launches a command.
- JSON-RPC messages are newline-delimited over stdin and stdout.
- Logging goes to stderr.
- stdout must contain only valid MCP protocol messages.
- Auth for stdio is outside the MCP authorization spec; credentials are usually
  supplied through environment variables or local config.

Streamable HTTP runs a remote or independent server process:

- The server exposes an HTTP MCP endpoint.
- Client-to-server messages are HTTP POST requests.
- Server replies can be direct JSON or request-scoped Server-Sent Events.
- HTTP GET can be used for server-to-client event streams, depending on server
  support.
- The transport supports remote deployments, standard HTTP controls, and the MCP
  OAuth authorization flow.

SSE is a legacy HTTP transport. Many clients still support it for compatibility,
but new remote deployments should prefer Streamable HTTP unless a target client
requires SSE.

For Connector's team MCP, Streamable HTTP should be the default downstream
transport because agents and hosted clients need a stable URL. stdio can still
matter at the edge, for example if an agent only accepts local stdio servers and
needs a small local bridge that forwards to Connector.

## Authorization

Authorization is optional in MCP, but remote protected servers should follow the
MCP authorization spec. The spec is based on OAuth 2.1 patterns plus several
OAuth standards:

- RFC 9728 Protected Resource Metadata for discovering which authorization
  server protects an MCP server.
- RFC 8414 OAuth Authorization Server Metadata, or OpenID Connect discovery, for
  authorization endpoints and capabilities.
- RFC 8707 Resource Indicators so issued Access Tokens are audience-bound to a
  specific MCP server.
- PKCE with S256 for public-client authorization-code flows.
- RFC 7591 Dynamic Client Registration where supported.

Important role mapping:

- The MCP client is the OAuth client.
- The MCP server is the OAuth resource server.
- The authorization server authenticates the resource owner and issues
  credentials for the MCP server.

The usual remote MCP authorization flow is:

1. Client calls the MCP endpoint without valid authorization.
2. Server replies with HTTP 401 and points the client to Protected Resource
   Metadata, or the client discovers metadata from the well-known location.
3. Client reads Protected Resource Metadata and finds the authorization server.
4. Client reads authorization server metadata.
5. Client obtains or resolves client identity through Client ID Metadata
   Documents, preregistration, or Dynamic Client Registration.
6. Client starts authorization-code plus PKCE in the browser.
7. User consents.
8. Client exchanges the authorization code and code verifier for Access and
   Refresh credentials.
9. Client sends `Authorization: Bearer ...` to the MCP server on future
   requests.

Security-critical requirements:

- Use PKCE S256 where technically capable.
- Include the `resource` parameter in both authorization and exchange requests
  so credentials are issued for the intended MCP server.
- Validate that presented credentials were issued for the receiving MCP server.
- Do not pass through credentials issued for a different upstream resource.
- Validate exact redirect URIs.
- Store state and code verifier server-side or in an integrity-protected store.
- Bind callback state to the signed-in user and Connector organization/member
  context.

The latest MCP spec adds step-up scope guidance. Initial authorization should
request only the scope needed for baseline functionality, using the scope from
the initial challenge when present. Higher-risk operations can trigger a later
scope challenge through `WWW-Authenticate`. A team gateway should expect that a
member may have enough permission to discover/read but not enough for a specific
write, and it should surface that as a reconnect or elevation path rather than a
generic tool failure.

## Dynamic Registration And Client Identity

Dynamic Client Registration lets an OAuth client register itself with an
authorization server at runtime. The client sends metadata such as redirect URIs,
grant types, response types, name, optional scope, and optional software
metadata. The authorization server returns client information, usually including
`client_id` and sometimes client authentication material.

This matters for MCP because general-purpose clients cannot pre-register with
every possible MCP authorization server. DCR removes manual setup for a large
class of remote MCP servers.

Current Connector behavior:

- `apps/connector/lib/mcp/oauth-provider.ts` creates an `OAuthClientProvider`
  for `@ai-sdk/mcp`.
- If no saved `clientInformation` exists, `@ai-sdk/mcp` performs RFC 7591 DCR
  against the authorization server metadata registration endpoint.
- Connector persists returned client information, authorization state, PKCE code
  verifier, and OAuth credentials in the encrypted Connector MCP credential
  payload.
- Callback routes complete the exchange by calling `auth(provider, {
  authorizationCode, callbackState })`.

The current behavior is a good fit for Linear-style hosted MCP OAuth. It should
not be treated as the only future path.

The 2025-11-25 MCP spec recommends support for OAuth Client ID Metadata
Documents as a newer client registration mechanism, with DCR as an optional
compatibility path. A future team MCP implementation should define an internal
client-identity abstraction so Connector can support:

- Dynamic Client Registration for servers that advertise a registration
  endpoint.
- Static preregistered client information for providers that require manual app
  setup.
- Client ID Metadata Documents when the SDK or local implementation supports
  that flow.

Provider support will vary. The product should store enough metadata to know how
client identity was established for a given provider/member connection, and it
should give operators a clear way to reconnect when the upstream registration
method changes.

## How Different Apps Use MCP

### Direct Desktop Or IDE Configuration

Claude Desktop, Cursor, VS Code, Codex CLI, and similar hosts let users add MCP
servers to user-level or workspace-level config. Common patterns:

- stdio command and args for local servers.
- Streamable HTTP URL for remote servers.
- Optional environment variables or headers for auth.
- OAuth browser flow for spec-compliant remote servers.
- Per-tool enablement and approval prompts in clients that expose those
  controls.

VS Code supports stdio, Streamable HTTP, and legacy SSE. It also supports tools,
prompts, resources, elicitation, sampling, server instructions, roots, and MCP
Apps. It warns users that local MCP servers can execute arbitrary code and
should come from trusted sources.

Codex uses `~/.codex/config.toml` and trusted project config layers for MCP
configuration. Its config supports stdio and HTTP endpoints, static HTTP
headers, environment-derived HTTP headers, OAuth callback configuration, OAuth
credential storage, requested scopes, per-tool approval mode, and tool
allowlists.

Direct config is powerful for individual developers, but it does not scale well
for a team product. Every agent/client must be configured separately, credentials
can drift, and policy/audit is scattered across clients.

### API-Hosted MCP Tools

OpenAI Responses API and Claude's MCP connector can connect to remote MCP
servers from an API request. This reduces client implementation work, but it
changes operational constraints:

- The MCP server must be reachable by the model provider's infrastructure.
- Only specific MCP features may be supported. For example, Claude's Messages
  API connector currently focuses on MCP tool calls, not all MCP primitives.
- API callers often need to provide an authorization credential themselves and
  manage refresh outside the model API.
- Tool filtering is important because importing many tool definitions increases
  cost and latency.

This pattern supports Connector's downstream direction if Connector exposes a
remote MCP endpoint that can be used by hosted model APIs.

### Gateway Or Proxy

Executor is the clearest pattern match for Connector. It presents one MCP
endpoint in front of many integrations, stores connection credentials itself,
attaches credentials to upstream calls, and enforces per-tool policy. It also
normalizes different integration types, including MCP, OpenAPI, and GraphQL,
into one tool catalog.

The gateway pattern gives Connector several advantages:

- One endpoint for every agent.
- Central credential storage.
- Team-level and member-level policy.
- Consistent audit trails.
- Upstream MCP servers can be added or removed without every user editing agent
  config.
- The agent never sees upstream OAuth credentials.

The gateway pattern also creates responsibility:

- Connector becomes a high-value authorization boundary.
- Connector must prevent cross-member credential use.
- Connector must validate tool calls before forwarding.
- Connector must make approval and audit semantics first-class, not hidden
  behind generic proxying.

## Catalog, Search, Inspect, Use

Large MCP catalogs create context and latency problems. MCP client best
practices recommend progressive tool discovery when tool definitions take a
meaningful part of the context window.

A practical layered model:

- Catalog: maintain a registry of connected providers, connections, tool names,
  descriptions, annotations, and policy summaries.
- Search: expose a small `search_tools` meta-tool that returns concise matches.
- Inspect: expose a way to fetch the full schema and policy for selected tools.
- Use: execute one selected upstream tool with validated arguments.

OpenCompany's main runner already follows a similar pattern for workspace MCP
providers through `{provider}__search_tools` and `{provider}__use_tool` in
`apps/runner/src/mcp-tools.ts`. Team MCP should copy the shape, not necessarily
the exact implementation:

- Downstream agents see stable Connector meta-tools.
- Connector searches raw upstream tools server-side.
- Connector executes raw upstream tools only after policy and credential checks.
- Connector can cache upstream tool catalogs, but must refresh on
  `list_changed`, cache expiry, reconnect, or failed schema validation.

This avoids injecting every Linear, Slack, Notion, GitHub, database, and internal
tool definition into every agent prompt.

## Policy And Approval

MCP tools can perform arbitrary reads and writes. Tool descriptions and
annotations are helpful, but they are not a security boundary. A team MCP layer
needs independent policy.

Recommended policy levels:

- Allow: run without interruption.
- Require approval: pause until a user or approved reviewer confirms.
- Block: never forward the call.

Recommended policy inputs:

- Organization.
- Member.
- Downstream agent/client identity.
- Upstream provider and connection.
- Raw upstream tool name.
- Tool annotations such as read-only or destructive hints, treated as advisory.
- Current requested arguments.
- Resource or project context when available.
- Scope/elevation state.

Default posture:

- Read/list/search operations can be allowed after install if the provider and
  member connection are trusted.
- Writes, deletes, sends, publishes, permission changes, payments, deploys, and
  external network actions should require approval by default.
- Unknown tools should require approval or be blocked until classified.
- Admin-only operations should be blocked unless explicitly enabled.

Approvals should be audited with the upstream tool name, arguments summary,
approver, acting member, downstream agent, timestamp, result, and correlation
id. Raw arguments may contain sensitive customer data, so audit storage should
support redaction and bounded retention.

## Per-Member Team MCP Model

The user's product intent is that every member in a Connector workspace gets
their own MCP setup. In practice, that should mean member-scoped upstream
connection credentials and policy context, not a single shared organization
credential.

Why organization-level credentials are not enough:

- An agent acting for Alice must not use Bob's Linear, Slack, Notion, GitHub, or
  internal service permissions.
- Upstream audit logs should show the real authorizing user where possible.
- Offboarding a member should revoke that member's access without breaking the
  whole workspace.
- Some providers grant different resource access per member.
- Approval rules may depend on the acting member's role.

Recommended conceptual data model:

- Team MCP endpoint: one downstream MCP server URL per Connector organization or
  workspace.
- Upstream integration: provider definition, endpoint, auth mode, catalog
  behavior, default policy.
- Member connection: provider plus Connector member plus OAuth client identity
  and upstream credentials.
- Team policy: organization-level defaults and overrides.
- Member policy state: personal enablement, denied providers, or delegated
  approval authority.
- Downstream client registration: which agent/client is allowed to connect to
  the team endpoint.

Credential lookup should be based on the acting member, not merely the
organization. A tool execution request should fail closed if Connector cannot
prove which member is acting or if that member lacks a valid upstream
connection.

## Recommended Team MCP Direction

Build Connector as an MCP gateway/proxy:

- Downstream agents connect to one Connector MCP endpoint.
- Connector authenticates the downstream agent/client and resolves the acting
  Connector organization and member.
- Connector maintains a server-side catalog of upstream MCP providers and raw
  tools.
- Connector stores upstream OAuth credentials per Connector organization member.
- Connector attaches the member's upstream credentials only when forwarding a
  call to the upstream MCP server.
- Connector never exposes upstream credentials to the downstream agent.
- Connector enforces policy before forwarding.
- Connector logs discovery, approval, execution, failure, reconnect, and
  elevation events.

Recommended first useful shape:

- Expose a small downstream tool set: search team tools, describe a selected
  tool, execute a selected tool.
- Start with upstream MCP providers already proven in this repo, beginning with
  Linear.
- Keep upstream raw tools behind a policy layer.
- Use existing Connector OAuth route patterns for the first provider, but change
  future storage semantics to member-scoped credentials before shipping team
  usage.
- Defer full MCP resources/prompts passthrough until tool proxying, auth, and
  audit are correct.

Non-goals for the first implementation:

- Do not build a bespoke REST wrapper for every upstream provider if its hosted
  MCP server already solves the tool surface.
- Do not inject the whole upstream tool catalog into the downstream model by
  default.
- Do not share one upstream OAuth credential across the organization.
- Do not rely only on upstream tool annotations for safety.
- Do not expose local stdio process spawning from a hosted Connector endpoint.

## Security Notes

### Credential Boundary

The most important boundary is: downstream agents may request actions, but they
must not receive upstream credentials. Connector should store encrypted upstream
credential payloads and attach them only in server-side calls to upstream MCP
servers.

Credential encryption should bind encrypted payloads to the organization,
member, provider/server, credential kind, and key version. This prevents a row
copied to another context from decrypting successfully.

### Audience And Passthrough

MCP security guidance explicitly warns against accepting credentials issued for
another service. Connector should not act as a blind pass-through for arbitrary
Bearer values. For upstream OAuth, Connector should store credentials issued for
the upstream MCP server and only use them with that server. For downstream
Connector access, Connector should issue or validate separate credentials whose
audience is Connector's team MCP endpoint.

### SSRF And Metadata Discovery

OAuth metadata discovery can create SSRF risk because clients fetch URLs from
headers and metadata documents. Connector is server-side software, so it should
enforce production SSRF controls for any user-configurable MCP server URL:

- Require HTTPS for production remote servers.
- Block loopback, link-local, private-network, and cloud metadata IP ranges
  unless an operator explicitly allows them in a trusted deployment.
- Reject redirects to disallowed hosts.
- Resolve DNS carefully and protect against DNS rebinding where practical.
- Prefer allowlisted provider endpoints for first-party integrations.

### Tool Injection And Prompt Injection

Tool names, descriptions, resource text, and upstream error messages are
untrusted input. Connector should not let upstream MCP content override system
instructions, policy, approval decisions, or credential routing. Tool
descriptions can help the model choose a tool, but policy should come from
Connector-controlled data.

### Local Process Risk

stdio MCP servers can run arbitrary local commands. A hosted team MCP gateway
should not expose a generic "spawn any stdio server" feature. If local MCP
support is needed later, use a constrained local bridge or sandboxed worker with
allowlisted commands, clear install provenance, and explicit user trust.

### Offboarding

Member-scoped setup should make offboarding straightforward:

- Disable the member's Connector account or organization membership.
- Stop accepting downstream calls acting as that member.
- Revoke or delete that member's upstream credentials.
- Keep audit records according to retention policy.

## Current Repo Notes

Connector currently has a small MCP OAuth implementation under
`apps/connector/lib/mcp/*`.

Current Connector MCP data:

- `connectorMcpServers` in `packages/db/src/schema.ts` stores one server row per
  Connector organization and `serverKey`.
- `connectorMcpCredentials` stores encrypted credential payloads for a server
  and credential kind.
- The unique credential index is on `serverId` and `kind`, so the current shape
  is organization/server-scoped, not member-scoped.
- `connectedByUserId` records who connected the org-level server, but it does
  not make the stored upstream credential personal to that user.

Current Linear OAuth flow:

- `apps/connector/lib/mcp/data.ts` defines Linear as the first upstream MCP
  server at `https://mcp.linear.app/mcp`.
- `apps/connector/lib/mcp/oauth-provider.ts` creates a provider object for
  `@ai-sdk/mcp` auth.
- `apps/connector/app/api/mcp/linear/start/route.ts` starts the OAuth flow.
- `apps/connector/app/api/mcp/linear/callback/route.ts` completes it.
- OAuth callback state is HMAC-signed in
  `apps/connector/lib/mcp/oauth-state.ts`, includes organization id, user id,
  return path, expiry, and nonce, and is sanitized on return.
- Credential payload encryption is implemented in
  `apps/connector/lib/mcp/credential-storage.ts` using the shared crypto
  package and authenticated data.

Current `@ai-sdk/mcp` behavior:

- The local package exposes `auth(provider, { serverUrl })` and an
  `OAuthClientProvider` interface.
- The provider supplies redirect URL, client metadata, saved client
  information, saved credentials, state, and PKCE verifier methods.
- If client information is missing, the SDK discovers OAuth metadata and
  performs RFC 7591 Dynamic Client Registration when the upstream authorization
  server supports it.
- The SDK refreshes credentials when refresh data is available and starts a new
  authorization flow when it is not.

Main OpenCompany has a larger workspace MCP path:

- `apps/web/lib/mcp/*` handles several workspace MCP providers.
- `apps/runner/src/mcp-tools.ts` connects the runner to configured workspace MCP
  servers.
- The runner exposes provider-level search/use meta-tools instead of blindly
  preloading every raw upstream tool.

The team MCP implementation should learn from both paths, but it should not copy
their workspace/org credential ownership as-is. Team MCP needs a member-scoped
credential boundary from the start.

## Implementation Checklist For A Future Build

Use this checklist when turning the research into code:

- Define the downstream Connector MCP server identity and URL shape.
- Decide how downstream agents authenticate to Connector and how Connector maps
  a call to an acting organization member.
- Introduce member-scoped upstream MCP credential storage before allowing team
  execution.
- Keep provider definitions separate from member connections.
- Implement upstream OAuth through a registration abstraction that can support
  DCR, preregistration, and Client ID Metadata Documents.
- Build catalog/search/describe/use meta-tools before exposing raw upstream
  tools directly.
- Add policy classification, approval state, and audit logging before enabling
  write operations.
- Add SSRF controls for custom remote MCP URLs.
- Add reconnect and step-up flows for missing, expired, invalid, or insufficient
  upstream authorization.
- Add tests for cross-member isolation, callback state binding, policy blocking,
  approval-required tools, credential deletion, and not-connected behavior.
