export type MicrosoftIntegrationProvider = "outlook" | "outlook-calendar";
export const MICROSOFT_PROVIDER_CONFIG = {
  outlook: { displayName: "Outlook", scopes: ["offline_access", "User.Read", "Mail.ReadWrite"] },
  "outlook-calendar": {
    displayName: "Outlook Calendar",
    scopes: ["offline_access", "User.Read", "Calendars.ReadWrite"],
  },
} as const;

export function microsoftScopesSatisfied(
  provider: MicrosoftIntegrationProvider,
  scopes: readonly string[],
) {
  const granted = new Set(
    scopes.map((scope) => scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase()),
  );
  return MICROSOFT_PROVIDER_CONFIG[provider].scopes
    .filter((scope) => scope !== "offline_access")
    .every((scope) => granted.has(scope.toLowerCase()));
}
