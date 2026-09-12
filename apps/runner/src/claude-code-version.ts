export const CLAUDE_CODE_CLI_VERSION = "2.1.220";
export const CLAUDE_CODE_CLI_PACKAGE = `@anthropic-ai/claude-code@${CLAUDE_CODE_CLI_VERSION}`;

// The ACP adapter is installed inside the coding sandbox. Keep it pinned so its
// wire or event mapping cannot change independently of a runner deploy. The adapter
// runs every turn with the Claude binary bundled by its own pinned
// @anthropic-ai/claude-agent-sdk, so this pin — not CLAUDE_CODE_CLI_VERSION — decides
// which models a Claude turn accepts. 0.76.0 ships SDK 0.3.257, which knows Fable 5.1.
export const CLAUDE_CODE_ACP_ADAPTER_VERSION = "0.76.0";
export const CLAUDE_CODE_ACP_ADAPTER_PACKAGE = `@agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_ADAPTER_VERSION}`;
