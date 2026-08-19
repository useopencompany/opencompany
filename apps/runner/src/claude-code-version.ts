// The ACP adapter is installed inside the coding sandbox. Keep it pinned so a
// runner deploy cannot pick up an independent wire or event-mapping change. Its
// published manifest also pins the underlying Claude Agent SDK exactly.
export const CLAUDE_CODE_ACP_ADAPTER_VERSION = "0.70.0";
export const CLAUDE_CODE_ACP_ADAPTER_PACKAGE = `@agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_ADAPTER_VERSION}`;
