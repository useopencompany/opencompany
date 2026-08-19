export const CLAUDE_CODE_CLI_VERSION = "2.1.220";
export const CLAUDE_CODE_CLI_PACKAGE = `@anthropic-ai/claude-code@${CLAUDE_CODE_CLI_VERSION}`;

// The ACP adapter is installed inside the coding sandbox, next to the legacy
// Claude CLI. Keep it pinned so the flag-gated pilot cannot pick up a wire or
// event-mapping change independently of a runner deploy.
export const CLAUDE_CODE_ACP_ADAPTER_VERSION = "0.70.0";
export const CLAUDE_CODE_ACP_ADAPTER_PACKAGE = `@agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_ADAPTER_VERSION}`;
