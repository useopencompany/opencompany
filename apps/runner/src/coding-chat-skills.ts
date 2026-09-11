export function codingChatSkillPromptLines(skillPaths: readonly string[]) {
  if (skillPaths.length === 0) return [];
  return [
    "",
    "<invoked_skills>",
    "The user invoked these skills with this message. Read each SKILL.md and follow its instructions:",
    ...skillPaths.map((path) => `- ${path}`),
    "</invoked_skills>",
  ];
}
