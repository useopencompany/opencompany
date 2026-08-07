import { ADJUSTABLE_DEFAULT_BRAIN_FOLDERS } from "@opencompany/brain/schema";

export const ONBOARDING_ROLE_IDS = [
  "founder",
  "product",
  "sales",
  "marketing",
  "operations",
  "investing",
  "consulting",
  "research",
] as const;

export type OnboardingRole = (typeof ONBOARDING_ROLE_IDS)[number];

export const ONBOARDING_ROLE_FOLDERS = {
  founder: ["thoughts", "projects", "product", "meetings", "decisions", "fundraising", "metrics"],
  product: ["projects", "specs", "meetings", "decisions", "research", "incidents"],
  sales: ["deals", "meetings", "calls", "playbooks", "competitors", "notes"],
  marketing: ["campaigns", "content", "research", "meetings", "ideas", "competitors"],
  operations: ["projects", "processes", "meetings", "decisions", "metrics", "vendors"],
  investing: ["deals", "meetings", "research", "thesis", "portfolio", "notes"],
  consulting: ["clients", "projects", "meetings", "deliverables", "research", "notes"],
  research: ["research", "sources", "notes", "concepts", "meetings", "reports"],
} as const satisfies Record<OnboardingRole, readonly string[]>;

export const ONBOARDING_COMPANY_URL_MAX_LENGTH = 2_048;

const ONBOARDING_ROLES = new Set<string>(ONBOARDING_ROLE_IDS);

export function isOnboardingRole(value: unknown): value is OnboardingRole {
  return typeof value === "string" && ONBOARDING_ROLES.has(value);
}

export function onboardingFoldersForRole(role: unknown): string[] {
  return isOnboardingRole(role)
    ? [...ONBOARDING_ROLE_FOLDERS[role]]
    : [...ADJUSTABLE_DEFAULT_BRAIN_FOLDERS];
}

export function normalizeOnboardingCompanyUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ONBOARDING_COMPANY_URL_MAX_LENGTH) return null;

  const candidate = /^https?:/i.test(trimmed)
    ? trimmed
    : /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    // Require a real domain (at least one dot and a plausible letter TLD) so
    // bare words like "jamie" — which new URL() otherwise accepts as a
    // single-label hostname — don't pass as a company URL.
    const labels = url.hostname.split(".");
    const tld = labels[labels.length - 1] ?? "";
    if (labels.length < 2 || labels.some((label) => label.length === 0)) return null;
    if (!/^[a-z]{2,}$/i.test(tld)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function parseOnboardingProfile(input: {
  role: unknown;
  companyUrl: unknown;
}): { ok: true; role: OnboardingRole; companyUrl: string } | { ok: false; error: string } {
  if (!isOnboardingRole(input.role)) {
    return { ok: false, error: "Choose the role that best describes you." };
  }
  if (typeof input.companyUrl !== "string" || !input.companyUrl.trim()) {
    return { ok: false, error: "Enter your company URL." };
  }

  const companyUrl = normalizeOnboardingCompanyUrl(input.companyUrl);
  if (!companyUrl) return { ok: false, error: "Enter a valid company URL." };

  return { ok: true, role: input.role, companyUrl };
}
