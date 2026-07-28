export const GOAT_GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOAT_GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const GMAIL_SEND_CAPABLE_SCOPES = new Set([
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  GOAT_GMAIL_SEND_SCOPE,
]);

export function hasGoatGmailSendScope(scopes: unknown): boolean {
  return (
    Array.isArray(scopes) &&
    scopes.some((scope) => typeof scope === "string" && GMAIL_SEND_CAPABLE_SCOPES.has(scope))
  );
}
