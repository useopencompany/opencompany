export const personalBrainFolderOptions = [
  {
    value: "meetings",
    label: "Meetings",
    description: "Notes, decisions, action items, and follow-ups.",
  },
  {
    value: "projects",
    label: "Projects",
    description: "Plans, working docs, milestones, and open questions.",
  },
  {
    value: "product",
    label: "Product",
    description: "Ideas, specs, customer feedback, and roadmap thinking.",
  },
  {
    value: "company",
    label: "Company",
    description: "Operating notes, values, and internal reference material.",
  },
  {
    value: "strategy",
    label: "Strategy",
    description: "Memos, positioning, priorities, and long-range decisions.",
  },
  {
    value: "growth",
    label: "Growth",
    description: "Experiments, channels, campaigns, and funnel learnings.",
  },
] as const;

export type PersonalBrainFolder = (typeof personalBrainFolderOptions)[number]["value"];

export const personalBrainFolderValues = personalBrainFolderOptions.map((option) => option.value);
