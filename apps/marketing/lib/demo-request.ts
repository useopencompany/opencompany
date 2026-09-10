export const DEMO_COMPANY_TYPES = [
  "B2B venture-backed startup",
  "B2C venture-backed startup",
  "Bootstrapped startup",
  "AI implementation partner",
  "VC / accelerator",
  "Small business / professional services / agency",
  "Other",
] as const;

export const DEMO_TEAM_SIZES = ["Just me", "2–10", "11–50", "51–200", "201+"] as const;

export type DemoRequest = {
  email: string;
  companyType: (typeof DEMO_COMPANY_TYPES)[number];
  teamSize: (typeof DEMO_TEAM_SIZES)[number];
};

// Match the existing event's custom booking question values so visitors do not
// need to answer team size twice. Keep the precise marketing answer in notes.
const calendarTeamSizes: Record<DemoRequest["teamSize"], string> = {
  "Just me": "Just me",
  "2–10": "2-10",
  "11–50": "10-50",
  "51–200": ">50",
  "201+": ">50",
};

export function demoBookingUrl({ email, companyType, teamSize }: DemoRequest) {
  const url = new URL("https://cal.com/louis-morgner-k0wc9i/opencompany-onboarding");
  url.searchParams.set("email", email.trim());
  url.searchParams.set("notes", `Company type: ${companyType}\nTeam size: ${teamSize}`);
  url.searchParams.set("how-many-people-are-on-your-team", calendarTeamSizes[teamSize]);
  url.searchParams.set("metadata[companyType]", companyType);
  url.searchParams.set("metadata[teamSize]", teamSize);
  url.searchParams.set("theme", "light");
  url.searchParams.set("layout", "month_view");
  return url.toString();
}
