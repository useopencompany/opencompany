// Claude Code learned `claude-fable-5-1` in 2.1.257, so anything older rejects the
// model the runner sets via ANTHROPIC_MODEL and the ACP `model` config option. 2.1.269
// also carries the Fable 5.1 prompt-cache fix for context attached after tool results.
export const CLAUDE_CODE_CLI_VERSION = "2.1.269";
export const CLAUDE_CODE_CLI_PACKAGE = `@anthropic-ai/claude-code@${CLAUDE_CODE_CLI_VERSION}`;

// The ACP adapter is installed inside the coding sandbox. Keep it pinned so its
// wire or event mapping cannot change independently of a runner deploy.
export const CLAUDE_CODE_ACP_ADAPTER_VERSION = "0.76.0";
export const CLAUDE_CODE_ACP_ADAPTER_PACKAGE = `@agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_ADAPTER_VERSION}`;
