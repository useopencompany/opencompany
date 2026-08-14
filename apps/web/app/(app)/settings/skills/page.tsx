import { SkillsSettingsRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { listHeadlessSkills } from "@/lib/headless-knowledge-server";

export default async function SkillsSettingsPage() {
  const context = await currentUser();
  const skills = await listHeadlessSkills();
  return <SkillsSettingsRoute skills={skills} canEdit={context.role === "admin"} />;
}
