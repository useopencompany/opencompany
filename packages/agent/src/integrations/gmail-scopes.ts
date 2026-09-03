export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const GMAIL_MCP_CAPABLE_SCOPES = new Set(["https://mail.google.com/", GMAIL_MODIFY_SCOPE]);

const GMAIL_DRAFT_CAPABLE_SCOPES = new Set([
  "https://mail.google.com/",
  GMAIL_MODIFY_SCOPE,
  GMAIL_COMPOSE_SCOPE,
]);

const GMAIL_SEND_CAPABLE_SCOPES = new Set([
  "https://mail.google.com/",
  GMAIL_MODIFY_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SEND_SCOPE,
]);

export function hasGmailDraftScope(scopes: unknown): boolean {
  return hasAnyGmailScope(scopes, GMAIL_DRAFT_CAPABLE_SCOPES);
}

export function hasGmailSendScope(scopes: unknown): boolean {
  return hasAnyGmailScope(scopes, GMAIL_SEND_CAPABLE_SCOPES);
}

export function gmailMcpScopesSatisfied(scopes: unknown): boolean {
  return hasAnyGmailScope(scopes, GMAIL_MCP_CAPABLE_SCOPES);
}

function hasAnyGmailScope(scopes: unknown, allowed: ReadonlySet<string>): boolean {
  return (
    Array.isArray(scopes) && scopes.some((scope) => typeof scope === "string" && allowed.has(scope))
  );
}
