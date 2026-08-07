const GOAT_ONBOARDING_KICKOFF_STORAGE_KEY = "goat-onboarding-kickoff-v1";

export function buildOnboardingKickoffPrompt(companyUrl: string) {
  return `You're helping me seed our company Brain for the first time. Keep this workflow in main chat and work transparently with me.

1. Survey breadth before depth. First identify the most relevant Slack channels, Gmail threads, Linear projects/issues, and other useful surfaces. Then go deeper only where there is durable company knowledge: decisions, product direction, customers, team, and process. Skip bots, notifications, routine status churn, and chit-chat.
2. Use web search for public context on our company, product, customers, team, and recent news. Only include it if it is definitely the right company and accurate.
3. Save several focused findings rather than one large dump:
   - For Slack, Gmail, or Linear findings, call save_to_brain with the action result's sourceRef and integrationId, omitting content so background ingestion can hydrate the complete provider source. Add only a short fallbackContent if useful.
   - For web findings, save faithful content with the page URL as sourceRef.
4. After the first pass, summarize what you saved, what you skipped, and why. Then ask what I want you to deepen.

Company: ${companyUrl}`;
}

export function queueOnboardingKickoff(companyUrl: string): boolean {
  try {
    window.sessionStorage.setItem(GOAT_ONBOARDING_KICKOFF_STORAGE_KEY, companyUrl);
    return true;
  } catch {
    return false;
  }
}

export function consumeOnboardingKickoffPrompt(): string | null {
  try {
    const companyUrl = window.sessionStorage.getItem(GOAT_ONBOARDING_KICKOFF_STORAGE_KEY);
    window.sessionStorage.removeItem(GOAT_ONBOARDING_KICKOFF_STORAGE_KEY);
    return companyUrl ? buildOnboardingKickoffPrompt(companyUrl) : null;
  } catch {
    return null;
  }
}
