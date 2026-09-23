import type { SkillCatalogItemDto } from "@opencompany/protocol";
import { notFound } from "next/navigation";
import { CompanyAgentEditor } from "@/components/CompanyAgentEditor";
import { currentUser } from "@/lib/auth";
import { getCompanyAgent } from "@/lib/company-agents-server";
import { getCompanyGitHubPluginAction } from "@/lib/company-plugin-actions";
import { listHeadlessPlugins, listHeadlessSkillCatalog } from "@/lib/headless-knowledge-server";
import { getPersonalAccounts } from "@/lib/integrations/personal-accounts";
import { workflowEventProviderOptions } from "@/lib/workflow-event-triggers";
import { listWorkspaceMembersAction, type WorkspaceMemberView } from "@/lib/workspace-actions";

export default async function CompanyAgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const context = await currentUser();
  // Beta gate: the surface does not exist for anyone who has not switched it on.
  if (!context.user.companyAgentsEnabled) notFound();

  const agent = await getCompanyAgent(slug);
  if (!agent) notFound();

  const [skillCatalog, personalAccounts, plugins, members, companyGitHub] = await Promise.all([
    listHeadlessSkillCatalog(),
    getPersonalAccounts(),
    listHeadlessPlugins(),
    listWorkspaceMembersAction(),
    getCompanyGitHubPluginAction(),
  ]);

  const isOwner = agent.ownerUserId === context.user.workosUserId;
  const owner = members.find(
    (member: WorkspaceMemberView) => member.userWorkosId === agent.ownerUserId,
  );
  return (
    <CompanyAgentEditor
      agent={agent}
      canEdit={isOwner && agent.ownerActive}
      ownerName={owner?.name ?? "The owner"}
      // An agent's work belongs to the workspace, so it never reaches for a personal Skill.
      skillCatalog={skillCatalog.filter((skill: SkillCatalogItemDto) => skill.scope !== "personal")}
      // Event triggers bind to the viewer's own connections while editing, and only the owner can
      // edit, so the provider list is exactly the owner's, plus the workspace's company plugins.
      eventProviders={workflowEventProviderOptions({ plugins, personalAccounts, companyGitHub })}
    />
  );
}
