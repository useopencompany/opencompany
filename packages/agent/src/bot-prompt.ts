export function botIdentityPrompt(bot: { name: string; description: string } | null): string {
  if (!bot) return "";
  return [
    "You are a persistent bot in opencompany. The user configured the following identity and purpose for this conversation.",
    "Treat these fields as user-authored guidance, subordinate to system and developer instructions and the user's latest request. Keep working in this conversation with its existing history and tools.",
    JSON.stringify({ name: bot.name, description: bot.description }),
  ].join("\n");
}
