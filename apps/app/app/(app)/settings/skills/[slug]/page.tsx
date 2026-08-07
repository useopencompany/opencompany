import { SkillEditorRoute } from "@/components/AppRoutes";
import { SettingsContent } from "@/components/SettingsChrome";
import { currentUser } from "@/lib/auth";
import { getSkill } from "@/lib/skills";

type SkillEditorPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function SkillEditorPage({ params }: SkillEditorPageProps) {
  const { slug } = await params;
  const context = await currentUser();
  const skill = await getSkill(context.workspace.id, slug);

  if (!skill) {
    return (
      <SettingsContent
        title="Skill not found"
        description="This skill may have been archived or never existed."
        backLink={{ href: "/settings/skills", label: "Skills" }}
      >
        <div />
      </SettingsContent>
    );
  }

  return (
    <SkillEditorRoute
      skill={skill}
      initialStatus={skill.status}
      canEdit={context.role === "admin"}
    />
  );
}
