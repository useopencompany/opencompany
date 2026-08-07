export const GOAT_GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOAT_GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
export const GOAT_GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const GMAIL_DRAFT_CAPABLE_SCOPES = new Set([
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  GOAT_GMAIL_COMPOSE_SCOPE,
]);

const GMAIL_SEND_CAPABLE_SCOPES = new Set([
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  GOAT_GMAIL_COMPOSE_SCOPE,
  GOAT_GMAIL_SEND_SCOPE,
]);

export function hasGmailDraftScope(scopes: unknown): boolean {
  return hasAnyGmailScope(scopes, GMAIL_DRAFT_CAPABLE_SCOPES);
}

export function hasGmailSendScope(scopes: unknown): boolean {
  return hasAnyGmailScope(scopes, GMAIL_SEND_CAPABLE_SCOPES);
}

function hasAnyGmailScope(scopes: unknown, allowed: ReadonlySet<string>): boolean {
  return (
    Array.isArray(scopes) && scopes.some((scope) => typeof scope === "string" && allowed.has(scope))
  );
}
