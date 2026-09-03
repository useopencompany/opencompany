const ONBOARDING_KICKOFF_STORAGE_KEY = "goat-onboarding-kickoff-v1";

export function buildOnboardingKickoffPrompt(companyUrl: string) {
  return `You're helping me seed our company Wiki for the first time. Keep this workflow in main chat and work transparently with me.

1. Survey breadth before depth. First identify the most relevant Slack conversations, Gmail threads, Linear projects/issues, and other useful surfaces. Then go deeper only where there is durable company knowledge: decisions, product direction, customers, team, and process. Skip bots, notifications, routine status churn, and chit-chat.
2. Use web search for public context on our company, product, customers, team, and recent news. Only include it if it is definitely the right company and accurate.
3. Read the existing Wiki tree and relevant pages before editing. Write several focused Wiki pages rather than one large dump. Preserve useful source links in the page body, merge findings into an existing page when it is the natural home, and never overwrite a page without reading it first.
4. After the first pass, summarize what you saved, what you skipped, and why. Then ask what I want you to deepen.

Company: ${companyUrl}`;
}

export function queueOnboardingKickoff(companyUrl: string): boolean {
  try {
    window.sessionStorage.setItem(ONBOARDING_KICKOFF_STORAGE_KEY, companyUrl);
    return true;
  } catch {
    return false;
  }
}

export function consumeOnboardingKickoffPrompt(): string | null {
  try {
    const companyUrl = window.sessionStorage.getItem(ONBOARDING_KICKOFF_STORAGE_KEY);
    window.sessionStorage.removeItem(ONBOARDING_KICKOFF_STORAGE_KEY);
    return companyUrl ? buildOnboardingKickoffPrompt(companyUrl) : null;
  } catch {
    return null;
  }
}
