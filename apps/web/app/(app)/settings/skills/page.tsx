import { GoatSkillsSettingsRoute } from "@/components/GoatRoutes";
import { currentGoatUser } from "@/lib/auth";
import { listGoatSkills } from "@/lib/skills";

export default async function SkillsSettingsPage() {
  const context = await currentGoatUser();
  const skills = await listGoatSkills(context.workspace.id);
  return <GoatSkillsSettingsRoute skills={skills} canEdit={context.role === "admin"} />;
}
