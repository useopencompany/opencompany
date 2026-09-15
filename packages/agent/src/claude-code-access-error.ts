export const CLAUDE_CODE_CHAT_REAUTH_MESSAGE =
  "Claude Code is disconnected. Reconnect Claude Code in opencompany settings, then send your message again.";

export const CLAUDE_CODE_ORGANIZATION_ACCESS_DISABLED_MESSAGE =
  "Anthropic denied Claude Code subscription access for this account. Try again; if it continues, ask an Anthropic organization admin to check Claude Code access.";

const CREDENTIAL_REJECTED_PATTERN =
  /oauth|authenticat|unauthorized|401|login expired|invalid api key/i;
const ORGANIZATION_ACCESS_DISABLED_PATTERN =
  /organization has disabled claude subscription access for claude code/i;

type ClaudeCodeAccessFailureBase = {
  turnMessage: string;
  usageMessage: string;
};

export type ClaudeCodeAccessFailure =
  | (ClaudeCodeAccessFailureBase & {
      kind: "credential_rejected";
      invalidateCredential: true;
      statusReason: string;
    })
  | (ClaudeCodeAccessFailureBase & {
      kind: "organization_access_disabled";
      invalidateCredential: false;
    });

export function classifyClaudeCodeAccessFailure(value: string): ClaudeCodeAccessFailure | null {
  if (ORGANIZATION_ACCESS_DISABLED_PATTERN.test(value)) {
    return {
      kind: "organization_access_disabled",
      invalidateCredential: false,
      turnMessage: CLAUDE_CODE_ORGANIZATION_ACCESS_DISABLED_MESSAGE,
      usageMessage:
        "Anthropic denied Claude Code subscription access for this account. Try again; if it continues, ask an Anthropic organization admin to check Claude Code access.",
    };
  }
  if (CREDENTIAL_REJECTED_PATTERN.test(value)) {
    return {
      kind: "credential_rejected",
      invalidateCredential: true,
      turnMessage: CLAUDE_CODE_CHAT_REAUTH_MESSAGE,
      usageMessage: "Reconnect Claude Code to view subscription usage.",
      statusReason: "Claude Code rejected the stored token. Reconnect in opencompany settings.",
    };
  }
  return null;
}
