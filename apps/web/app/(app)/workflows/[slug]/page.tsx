import type { SkillCatalogItemDto } from "@opencompany/protocol";
import Link from "next/link";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { currentUser } from "@/lib/auth";
import { getCompanyGitHubPluginForTriggersAction } from "@/lib/company-plugin-actions";
import { getHeadlessWorkflow, getHeadlessWorkflowMemory } from "@/lib/headless-automation-server";
import { canManageWorkflowScope } from "@/lib/headless-automation-types";
import { listHeadlessPlugins, listHeadlessSkillCatalog } from "@/lib/headless-knowledge-server";
import { getPersonalAccounts } from "@/lib/integrations/personal-accounts";
import { getSlackBotWorkspaceSettingsAction } from "@/lib/slack-bot-actions";
import { workflowEventProviderOptions } from "@/lib/workflow-event-triggers";
import { listWorkspaceMembersAction, type WorkspaceMemberView } from "@/lib/workspace-actions";

type WorkflowEditorPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function WorkflowEditorPage({ params }: WorkflowEditorPageProps) {
  const { slug } = await params;
  const context = await currentUser();
  const [
    workflow,
    memory,
    skillCatalog,
    personalAccounts,
    plugins,
    members,
    slackBotSettings,
    companyGitHub,
  ] = await Promise.all([
    getHeadlessWorkflow(slug),
    getHeadlessWorkflowMemory(slug),
    listHeadlessSkillCatalog(),
    getPersonalAccounts(),
    listHeadlessPlugins(),
    listWorkspaceMembersAction(),
    getSlackBotWorkspaceSettingsAction(),
    getCompanyGitHubPluginForTriggersAction(),
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

  const eventProviders = workflowEventProviderOptions({
    plugins,
    personalAccounts,
    companyGitHub,
  });
  const owner =
    members.find(
      (member: WorkspaceMemberView) => member.userWorkosId === workflow.createdByUserId,
    ) ??
    (workflow.createdByUserId === context.user.workosUserId
      ? {
          name:
            [context.user.firstName, context.user.lastName].filter(Boolean).join(" ") ||
            context.user.email,
          avatarUrl: context.user.avatarUrl,
        }
      : {
          name: workflow.createdByUserId ? "Former member" : "Workspace",
          avatarUrl: null,
        });
  return (
    <WorkflowEditor
      workflow={workflow}
      workspaceId={context.workspace.id}
      canEdit
      canManageScope={canManageWorkflowScope(workflow, {
        userId: context.user.workosUserId,
        role: context.role,
      })}
      skillCatalog={skillCatalog.filter(
        (skill: SkillCatalogItemDto) => workflow.scope === "personal" || skill.scope !== "personal",
      )}
      eventProviders={eventProviders}
      slackBotSettings={slackBotSettings}
      owner={{ name: owner.name, avatarUrl: owner.avatarUrl }}
      memory={memory ?? { workflowId: workflow.id, enabled: false, content: "", updatedAt: null }}
    />
  );
}
