import { SkillsSettingsRoute } from "@/components/Routes";
import { listHeadlessSkills } from "@/lib/headless-knowledge-server";

export default async function SkillsSettingsPage() {
  const skills = await listHeadlessSkills();
  return <SkillsSettingsRoute skills={skills} canEdit={true} />;
}
