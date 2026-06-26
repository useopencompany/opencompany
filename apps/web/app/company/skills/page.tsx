import CompanySkillsView from "@/components/CompanySkillsView";
import { listWorkspaceSkills } from "@/lib/skills/workspace-actions";

export default async function CompanySkillsPage() {
  const skills = await listWorkspaceSkills();
  return <CompanySkillsView initialSkills={skills} />;
}
