import { normalizeBrainFolder } from "./schema";

export const BRAIN_SKILLS_ZONE = "skills";

export function isBrainSkillFolder(value: string): boolean {
  const folder = normalizeBrainFolder(value);
  return folder === BRAIN_SKILLS_ZONE || folder.startsWith(`${BRAIN_SKILLS_ZONE}/`);
}
