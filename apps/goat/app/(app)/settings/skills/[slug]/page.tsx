import { GoatSkillEditorRoute } from "@/components/GoatRoutes";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";
import { currentGoatUser } from "@/lib/auth";
import { getGoatSkill } from "@/lib/skills";

type SkillEditorPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function SkillEditorPage({ params }: SkillEditorPageProps) {
  const { slug } = await params;
  const context = await currentGoatUser();
  const skill = await getGoatSkill(context.workspace.id, slug);

  if (!skill) {
    return (
      <GoatSettingsContent
        title="Skill not found"
        description="This skill may have been archived or never existed."
        backLink={{ href: "/settings/skills", label: "Skills" }}
      >
        <div />
      </GoatSettingsContent>
    );
  }

  return (
    <GoatSkillEditorRoute
      skill={skill}
      initialStatus={skill.status}
      canEdit={context.role === "admin"}
    />
  );
}
