import Link from "next/link";
import { TasksWorkflowsDisabledRoute } from "@/components/Routes";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { currentUser } from "@/lib/auth";
import { getHeadlessWorkflow } from "@/lib/headless-automation-server";
import { listHeadlessSkillCatalog } from "@/lib/headless-knowledge-server";
import type { IntegrationAccountView } from "@/lib/integration-state";
import { getPersonalAccounts } from "@/lib/integrations/personal-accounts";

type WorkflowEditorPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function WorkflowEditorPage({ params }: WorkflowEditorPageProps) {
  const { slug } = await params;
  const context = await currentUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  const [workflow, skillCatalog, personalAccounts] = await Promise.all([
    getHeadlessWorkflow(slug),
    listHeadlessSkillCatalog(),
    getPersonalAccounts(),
  ]);

  if (!workflow) {
    return (
      <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
        <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
          <div className="flex w-full max-w-[760px] flex-col gap-4 pb-24 pt-16 sm:pt-24">
            <Link
              href="/workflows"
              prefetch
              className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              Workflows
            </Link>
            <h1 className="text-[24px] font-semibold leading-tight text-ink">Workflow not found</h1>
            <p className="text-[13px] leading-5 text-ink-subtle">
              This workflow may have been archived or never existed.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const linearAccounts = personalAccounts.linear
    .filter((account: IntegrationAccountView) => account.connected)
    .map((account: IntegrationAccountView) => ({
      integrationId: account.integrationId,
      label: account.connectionLabel ?? account.accountName ?? account.accountEmail ?? "Linear",
    }));
  return (
    <WorkflowEditor
      workflow={workflow}
      workspaceId={context.workspace.id}
      canEdit
      skillCatalog={skillCatalog}
      linearAccounts={linearAccounts}
    />
  );
}
