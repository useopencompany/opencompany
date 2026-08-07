import { SkillsSettingsRoute } from "@/components/AppRoutes";
import { currentUser } from "@/lib/auth";
import { listSkills } from "@/lib/skills";

export default async function SkillsSettingsPage() {
  const context = await currentUser();
  const skills = await listSkills(context.workspace.id);
  return <SkillsSettingsRoute skills={skills} canEdit={context.role === "admin"} />;
}
