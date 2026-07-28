import { GoatSkillEditorRoute } from "@/components/GoatRoutes";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";
import { currentGoatUser } from "@/lib/auth";
import { getGoatSkill, listGoatSkills } from "@/lib/skills";

type SkillEditorPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function SkillEditorPage({ params }: SkillEditorPageProps) {
  const { slug } = await params;
  const context = await currentGoatUser();
  const [skill, list] = await Promise.all([
    getGoatSkill(context.workspace.id, slug),
    listGoatSkills(context.workspace.id),
  ]);

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

  const status = list.find((item) => item.slug === slug)?.status ?? "draft";

  return (
    <GoatSkillEditorRoute skill={skill} initialStatus={status} canEdit={context.role === "admin"} />
  );
}
