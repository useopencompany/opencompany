import { SkillsRoute } from "@/components/Routes";
import { listHeadlessSkills } from "@/lib/headless-knowledge-server";

export default async function SkillsPage() {
  const skills = await listHeadlessSkills();
  return <SkillsRoute skills={skills} canEdit={true} />;
}
