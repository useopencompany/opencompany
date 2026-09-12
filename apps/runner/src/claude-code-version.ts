export const CLAUDE_CODE_CLI_VERSION = "2.1.220";
export const CLAUDE_CODE_CLI_PACKAGE = `@anthropic-ai/claude-code@${CLAUDE_CODE_CLI_VERSION}`;

// The ACP adapter is installed inside the coding sandbox. Keep it pinned so its
// wire or event mapping cannot change independently of a runner deploy. The adapter
// runs every turn with the Claude binary bundled by its own pinned
// @anthropic-ai/claude-agent-sdk, so this pin bounds — but does not decide — which
// models a Claude turn accepts: the adapter resolves the requested model against the
// list the connected Claude account is entitled to and rejects anything missing from
// it, however new the bundled binary is. A new CLAUDE_CODE_AGENT_MODEL_IDS entry needs
// a real turn on a connected account, not a version comparison.
export const CLAUDE_CODE_ACP_ADAPTER_VERSION = "0.76.0";
export const CLAUDE_CODE_ACP_ADAPTER_PACKAGE = `@agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_ADAPTER_VERSION}`;
