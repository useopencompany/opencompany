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

export const GOAT_ONBOARDING_BUILDING_MAX_LENGTH = 280;

const GOAT_ONBOARDING_ROLES = new Set<string>(GOAT_ONBOARDING_ROLE_IDS);

export function isGoatOnboardingRole(value: unknown): value is GoatOnboardingRole {
  return typeof value === "string" && GOAT_ONBOARDING_ROLES.has(value);
}

export function goatOnboardingFoldersForRole(role: unknown): string[] {
  return isGoatOnboardingRole(role)
    ? [...GOAT_ONBOARDING_ROLE_FOLDERS[role]]
    : [...ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS];
}

export function parseGoatOnboardingProfile(input: {
  role: unknown;
  building: unknown;
}): { ok: true; role: GoatOnboardingRole; building: string | null } | { ok: false; error: string } {
  if (!isGoatOnboardingRole(input.role)) {
    return { ok: false, error: "Choose the role that best describes you." };
  }
  if (input.building !== null && typeof input.building !== "string") {
    return { ok: false, error: "What you're building must be text." };
  }

  const building = input.building?.trim() ?? "";
  if (building.length > GOAT_ONBOARDING_BUILDING_MAX_LENGTH) {
    return {
      ok: false,
      error: `What you're building is too long (max ${GOAT_ONBOARDING_BUILDING_MAX_LENGTH} characters).`,
    };
  }

  return { ok: true, role: input.role, building: building || null };
}
