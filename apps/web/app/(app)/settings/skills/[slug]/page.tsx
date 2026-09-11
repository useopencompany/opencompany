import { SkillBundleRoute } from "@/components/Routes";
import { SettingsContent } from "@/components/SettingsChrome";
import { getHeadlessSkill } from "@/lib/headless-knowledge-server";

type SkillBundlePageProps = {
  params: Promise<{ slug: string }>;
};

export default async function SkillBundlePage({ params }: SkillBundlePageProps) {
  const { slug } = await params;
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

  return <SkillBundleRoute installation={skill} canEdit={skill.canEdit} />;
}
