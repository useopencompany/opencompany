import { helpAreaOptions, teamSizeOptions } from "@/lib/onboarding/options";

export type OnboardingKickoffInput = {
  role: string;
  teamSize: string;
  companyUrl: string | null;
  helpAreas: string[];
};

const TEAM_SIZE_LABELS = new Map(teamSizeOptions.map((option) => [option.value, option.label]));
const HELP_AREA_LABELS = new Map(helpAreaOptions.map((option) => [option.value, option.label]));

function labelFor(map: Map<string, string>, value: string) {
  return map.get(value) ?? value;
}

function joinWithAnd(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Builds the first message of a new user's onboarding session. It is shown as a normal
 * (visible) user message, so it reads as if the user sent it — a warm, first-person ask that
 * carries the signup context. leo's behavior from there is driven by the opencompany-setup
 * skill in its system prompt, not by this text.
 */
export function buildOnboardingKickoffPrompt(input: OnboardingKickoffInput): string {
  const lines = ["Hi! I just signed up for OpenCompany and I'd love your help getting set up."];

  const details: string[] = [];
  if (input.role) details.push(`- My role: ${input.role}`);
  if (input.companyUrl) details.push(`- Company: ${input.companyUrl}`);
  if (input.teamSize) details.push(`- Team size: ${labelFor(TEAM_SIZE_LABELS, input.teamSize)}`);
  if (input.helpAreas.length > 0) {
    const areas = joinWithAnd(input.helpAreas.map((area) => labelFor(HELP_AREA_LABELS, area)));
    details.push(`- I'd most like help with: ${areas}`);
  }

  if (details.length > 0) {
    lines.push("", "A bit about me:", ...details);
  }

  lines.push(
    "",
    "Can you help me set up OpenCompany? Start with one focused set of setup questions if you need anything else from me.",
  );

  if (input.companyUrl) {
    lines.push(
      "",
      "I've linked my company above — feel free to take a quick look first so you have context.",
    );
  }

  return lines.join("\n");
}
