export const heardFromOptions = [
  { value: "friend_colleague", label: "A friend or colleague" },
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "youtube", label: "YouTube" },
  { value: "google", label: "Google" },
  { value: "ai_search", label: "AI search" },
  { value: "other", label: "Somewhere else" },
] as const;

export const teamSizeOptions = [
  { value: "1", label: "Just me" },
  { value: "2_10", label: "2-10" },
  { value: "11_50", label: "11-50" },
  { value: "51_200", label: "51-200" },
  { value: "201_1000", label: "201-1,000" },
  { value: "1000_plus", label: "1,000+" },
] as const;

export const agentExperienceOptions = [
  { value: "beginner", label: "I am new to agents" },
  { value: "medium", label: "I have tried agents for a few tasks" },
  { value: "expert", label: "I use agents regularly" },
] as const;

export const helpAreaOptions = [
  { value: "decisions", label: "Thinking through decisions" },
  { value: "deep_research", label: "Deep web research" },
  { value: "product_building", label: "Building the product" },
  { value: "icp_discovery", label: "Finding ICPs" },
  { value: "booking_meetings", label: "Booking meetings" },
  { value: "operations", label: "Operations" },
  { value: "hiring", label: "Hiring" },
] as const;

export type HeardFrom = (typeof heardFromOptions)[number]["value"];
export type TeamSize = (typeof teamSizeOptions)[number]["value"];
export type AgentExperience = (typeof agentExperienceOptions)[number]["value"];
export type HelpArea = (typeof helpAreaOptions)[number]["value"];

export const heardFromValues = heardFromOptions.map((option) => option.value);
export const teamSizeValues = teamSizeOptions.map((option) => option.value);
export const agentExperienceValues = agentExperienceOptions.map((option) => option.value);
export const helpAreaValues = helpAreaOptions.map((option) => option.value);
