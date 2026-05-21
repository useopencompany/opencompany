import { type LucideIcon, Search } from "lucide-react";

export type AgentTool = {
  id: string;
  label: string;
  icon: LucideIcon;
};

export const AGENT_TOOLS: AgentTool[] = [{ id: "exa", label: "exa", icon: Search }];

export function findTool(id: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.id === id);
}
