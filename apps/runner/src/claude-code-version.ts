// Keep the standalone CLI and adapter's bundled Agent SDK on the same Claude Code
// release. Opus 5.5 requires Claude Code 2.1.280 or newer.
export const CLAUDE_CODE_CLI_VERSION = "2.1.280";
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
// 0.81.0 pins @anthropic-ai/claude-agent-sdk 0.3.280, whose bundled Claude Code
// binary matches CLAUDE_CODE_CLI_VERSION. Existing sandboxes receive this adapter
// through ensureClaudeAcpAdapterInstalled before their next turn.
export const CLAUDE_CODE_ACP_ADAPTER_VERSION = "0.81.0";
export const CLAUDE_CODE_ACP_ADAPTER_PACKAGE = `@agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_ADAPTER_VERSION}`;
