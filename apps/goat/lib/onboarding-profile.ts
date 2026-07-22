import { ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS } from "@opencompany/goat-brain/schema";

export const GOAT_ONBOARDING_ROLE_IDS = [
  "founder",
  "product",
  "sales",
  "marketing",
  "operations",
  "investing",
  "consulting",
  "research",
] as const;

export type GoatOnboardingRole = (typeof GOAT_ONBOARDING_ROLE_IDS)[number];

export const GOAT_ONBOARDING_ROLE_FOLDERS = {
  founder: ["thoughts", "projects", "product", "meetings", "decisions", "fundraising", "metrics"],
  product: ["projects", "specs", "meetings", "decisions", "research", "incidents"],
  sales: ["deals", "meetings", "calls", "playbooks", "competitors", "notes"],
  marketing: ["campaigns", "content", "research", "meetings", "ideas", "competitors"],
  operations: ["projects", "processes", "meetings", "decisions", "metrics", "vendors"],
  investing: ["deals", "meetings", "research", "thesis", "portfolio", "notes"],
  consulting: ["clients", "projects", "meetings", "deliverables", "research", "notes"],
  research: ["research", "sources", "notes", "concepts", "meetings", "reports"],
} as const satisfies Record<GoatOnboardingRole, readonly string[]>;

export const GOAT_ONBOARDING_COMPANY_URL_MAX_LENGTH = 2_048;

const GOAT_ONBOARDING_ROLES = new Set<string>(GOAT_ONBOARDING_ROLE_IDS);

export function isGoatOnboardingRole(value: unknown): value is GoatOnboardingRole {
  return typeof value === "string" && GOAT_ONBOARDING_ROLES.has(value);
}

export function goatOnboardingFoldersForRole(role: unknown): string[] {
  return isGoatOnboardingRole(role)
    ? [...GOAT_ONBOARDING_ROLE_FOLDERS[role]]
    : [...ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS];
}

export function normalizeGoatOnboardingCompanyUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > GOAT_ONBOARDING_COMPANY_URL_MAX_LENGTH) return null;

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function parseGoatOnboardingProfile(input: {
  role: unknown;
  companyUrl: unknown;
}): { ok: true; role: GoatOnboardingRole; companyUrl: string } | { ok: false; error: string } {
  if (!isGoatOnboardingRole(input.role)) {
    return { ok: false, error: "Choose the role that best describes you." };
  }
  if (typeof input.companyUrl !== "string" || !input.companyUrl.trim()) {
    return { ok: false, error: "Enter your company URL." };
  }

  const companyUrl = normalizeGoatOnboardingCompanyUrl(input.companyUrl);
  if (!companyUrl) return { ok: false, error: "Enter a valid company URL." };

  return { ok: true, role: input.role, companyUrl };
}
