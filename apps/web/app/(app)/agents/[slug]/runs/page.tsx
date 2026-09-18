import { notFound } from "next/navigation";
import { CompanyAgentRuns } from "@/components/CompanyAgentRuns";
import { currentUser } from "@/lib/auth";
import { getCompanyAgent, listCompanyAgentRuns } from "@/lib/company-agents-server";

export default async function CompanyAgentRunsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const context = await currentUser();
  // Beta gate: the surface does not exist for anyone who has not switched it on.
  if (!context.user.companyAgentsEnabled) notFound();

  const agent = await getCompanyAgent(slug);
  if (!agent) notFound();
  const runs = await listCompanyAgentRuns(agent.id);
  return <CompanyAgentRuns agent={agent} runs={runs} />;
}
