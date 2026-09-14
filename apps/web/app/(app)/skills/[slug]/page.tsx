import { PageContent } from "@/components/PageContent";
import { SkillBundleRoute } from "@/components/Routes";
import { getHeadlessSkill } from "@/lib/headless-knowledge-server";

type SkillBundlePageProps = {
  params: Promise<{ slug: string }>;
};

export default async function SkillBundlePage({ params }: SkillBundlePageProps) {
  const { slug } = await params;
  const skill = await getHeadlessSkill(slug);

  if (!skill) {
    return (
      <PageContent
        title="Skill not found"
        description="This skill may have been archived or never existed."
        backLink={{ href: "/skills", label: "Skills" }}
      >
        <div />
      </PageContent>
    );
  }

  return <SkillBundleRoute installation={skill} canEdit={skill.canEdit} />;
}
