import { GoatSkillsSettingsRoute } from "@/components/GoatRoutes";
import { currentGoatUser } from "@/lib/auth";
import { listHeadlessSkills } from "@/lib/headless-knowledge-server";

export default async function SkillsSettingsPage() {
  const context = await currentGoatUser();
  const skills = await listHeadlessSkills();
  return <GoatSkillsSettingsRoute skills={skills} canEdit={context.role === "admin"} />;
}
