import { notFound } from "next/navigation";
import { CompanyAgentsList } from "@/components/CompanyAgentsList";
import { currentUser } from "@/lib/auth";
import { listCompanyAgents } from "@/lib/company-agents-server";
import { listWorkspaceMembersAction, type WorkspaceMemberView } from "@/lib/workspace-actions";

export default async function CompanyAgentsPage() {
  const context = await currentUser();
  // Beta gate: the surface does not exist for anyone who has not switched it on.
  if (!context.user.companyAgentsEnabled) notFound();

  // Owner names only decorate the list, so a workspace-settings failure degrades that column
  // rather than taking the page down with it.
  const [agents, members] = await Promise.all([
    listCompanyAgents(),
    listWorkspaceMembersAction().catch((error: unknown) => {
      console.error("[opencompany] Failed to load workspace members for the agent list", error);
      return null;
    }),
  ]);
  const ownerNames = members
    ? Object.fromEntries(
        members.map((member: WorkspaceMemberView) => [member.userWorkosId, member.name]),
      )
    : null;
  return <CompanyAgentsList agents={agents} ownerNames={ownerNames} />;
}
