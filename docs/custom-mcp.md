# Custom hosted MCP servers (PRO-228)

Settings → Plugins → Add custom MCP creates a standard immutable package from a public HTTPS
Streamable HTTP endpoint. The source is explicitly `custom_mcp`; it has no synthetic Git commit.
The package uses the existing workspace installation lifecycle. Connections, encrypted headers,
discovered tools, health, and per-tool permissions belong to the acting member, with no workspace
credential fallback. The broader personal-versus-workspace installation model is tracked in
[PRO-230](https://linear.app/actaso/issue/PRO-230/revisit-plugin-ownership-personal-plugins-now-workspace-support-later).

The first release accepts no authentication, a bearer token, or bounded custom authentication
headers. OAuth, local/stdio servers, private network endpoints, and legacy HTTP+SSE are outside
this release. Changing an endpoint means adding a new custom installation. Credentials can be
replaced on the existing installation; doing so resets its tool grants and approval revision.

Setup tests initialization and paginated discovery before installation. Installation repeats
discovery and checks the preview fingerprint, then saves the package and encrypted credentials
atomically. The Plugins detail page exposes refresh, reconnect, disconnect, individual Ask/On/Off
permissions, disable, and remove. Removing a custom installation also deletes its dedicated
personal connections and vault entries; it cannot leave credentials without a management surface.

All tools start on Ask, including advertised read-only tools. Custom actions use conservative
write effects and zero automatic call retries. Standing grants are configured per tool in Plugins;
the chat approval card offers a one-time decision. New or changed tool definitions reset grants
except Off. Every execution verifies the server's live discovery fingerprint before tools/call;
a mismatch stops dispatch and asks the user to refresh and review permissions. Durable approval
hashes also include the installation/account/revision, so an old approval cannot authorize a
rotated account or changed snapshot. Other engines continue through the same action gateway.
Codex and Claude Code Tasks pause for one-time approval and resume through that revision check.

Outbound requests validate public IP ranges after every DNS lookup and pin the checked address
to the TLS connection. Redirects and requests to any other endpoint are rejected. DNS, request,
discovery, response size, tool count, and schema depth have bounds. Authentication is injected
only in the guarded fetch, never handed to the OAuth discovery path. Raw transport errors are
replaced with actionable safe messages, and header values are redacted from discovery and results.

Migration `0259_custom_mcp_plugins.sql` adds the personal snapshot table and expands existing
provider/source checks. Apply it before running code that creates custom installations. For an
application rollback, remove custom installations through the current version first and retain
the additive database migration. Reverting the SQL checks requires separately removing all
`custom_mcp` rows and would destroy saved custom connection data.

Protocol reference: [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
