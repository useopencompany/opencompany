export const CODEX_CLI_VERSION = "0.153.4";
export const CODEX_CLI_PACKAGE = `@openai/codex@${CODEX_CLI_VERSION}`;
export const CODEX_CLI_VERSION_OUTPUT = `codex-cli ${CODEX_CLI_VERSION}`;

// codex-acp owns the app-server protocol boundary. Pin the adapter and its Codex
// runtime independently so npm cannot resolve the adapter's compatible range to a
// different engine version between sandbox image builds and lazy installations.
export const CODEX_ACP_ADAPTER_VERSION = "1.10.0";
export const CODEX_ACP_ADAPTER_PACKAGE = `@agentclientprotocol/codex-acp@${CODEX_ACP_ADAPTER_VERSION}`;
export const CODEX_ACP_ADAPTER_VERSION_OUTPUT = `@agentclientprotocol/codex-acp ${CODEX_ACP_ADAPTER_VERSION}`;
