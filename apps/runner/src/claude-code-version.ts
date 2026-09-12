export const CLAUDE_CODE_CLI_VERSION = "2.1.220";
export const CLAUDE_CODE_CLI_PACKAGE = `@anthropic-ai/claude-code@${CLAUDE_CODE_CLI_VERSION}`;

// The ACP adapter is installed inside the coding sandbox. Keep it pinned so its
// wire or event mapping cannot change independently of a runner deploy. The adapter
// runs every turn with the Claude binary bundled by its own pinned
// @anthropic-ai/claude-agent-sdk, so this pin bounds — but does not decide — which
// models a Claude turn accepts: the adapter also resolves the requested model against
// the list the connected Claude account is entitled to. A model the bundled binary knows
// can still be absent from the session's selectable options, which is why the runner
// opens the session on ANTHROPIC_MODEL and reconciles against what the adapter reports
// rather than asserting the id back at it.
export const CLAUDE_CODE_ACP_ADAPTER_VERSION = "0.76.0";
export const CLAUDE_CODE_ACP_ADAPTER_PACKAGE = `@agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_ADAPTER_VERSION}`;
