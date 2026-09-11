# Stripe plugin authorization

Stripe uses the official remote MCP server at `https://mcp.stripe.com`. The plugin's
**Connect Stripe account** action starts Stripe MCP OAuth, using discovery, dynamic client
registration, PKCE, and encrypted OAuth credential storage through the shared remote-MCP
integration. No Stripe API key or app-specific client secret is required for this flow.
The canonical API owns `/integrations/stripe/start` and `/integrations/stripe/callback`;
the web `/api/integrations/stripe/*` routes relay them.

The personal `stripe_mcp` connection takes precedence over a saved workspace restricted
key. An expired or incomplete OAuth connection requires reconnecting and never falls back
to the workspace key. Existing restricted keys continue to work when no OAuth connection
is present, with their admin-only management controls under **Manage existing workspace
API key**. Disconnecting a personal OAuth connection makes any existing workspace key
available again. Legacy direct Stripe API readers keep using workspace keys; MCP OAuth
tokens are only sent to Stripe's MCP server.

Stripe consent determines provider access; opencompany's tool approval modes still apply.
Users can revoke the provider session in Stripe Dashboard's **OAuth sessions** settings.
Stripe Connect operations on behalf of connected accounts require a restricted platform key
and are not part of this personal OAuth flow. See [Stripe MCP documentation](https://docs.stripe.com/mcp).
