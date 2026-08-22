import { SkillBundleRoute } from "@/components/Routes";
import { SettingsContent } from "@/components/SettingsChrome";
import { currentUser } from "@/lib/auth";
import { getHeadlessSkill } from "@/lib/headless-knowledge-server";

type SkillEditorPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function SkillEditorPage({ params }: SkillEditorPageProps) {
  const { slug } = await params;
  const context = await currentUser();
  const skill = await getHeadlessSkill(slug);

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

  return <SkillBundleRoute installation={skill} canEdit={context.role === "admin"} />;
}
