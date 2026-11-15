import { WorkflowsRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { getCompanyGitHubPluginAction } from "@/lib/company-plugin-actions";
import { listHeadlessWorkflows } from "@/lib/headless-automation-server";
import { listHeadlessPlugins } from "@/lib/headless-knowledge-server";
import { getPersonalAccounts } from "@/lib/integrations/personal-accounts";
import { getCompanySentryPluginAction } from "@/lib/sentry-actions";
import { WORKFLOW_TEMPLATES, workflowTemplateMissingPlugins } from "@/lib/workflow-templates";
import { listWorkspaceMembersAction, type WorkspaceMemberView } from "@/lib/workspace-actions";

export default async function WorkflowsPage() {
  const context = await currentUser();

  // The API only returns company workflows plus this user's personal ones, so every row here is
  // one they can open and edit. Owner names only decorate that list, so a workspace-settings
  // failure degrades the Owner column rather than taking the whole page down with it.
  // Plugin, account, and company-connection state only decorates the template cards with what still
  // needs connecting, so a failure there drops the setup hints rather than taking the page down.
  // They load together because a partial read would let a card claim GitHub is unconnected when it
  // is only unreadable.
  const [workflows, members, templateSetup] = await Promise.all([
    listHeadlessWorkflows(),
    listWorkspaceMembersAction().catch((error: unknown) => {
      console.error("[opencompany] Failed to load workspace members for the workflow list", error);
      return null;
    }),
    Promise.all([
      listHeadlessPlugins(),
      getPersonalAccounts(),
      getCompanyGitHubPluginAction(),
      getCompanySentryPluginAction(),
    ]).catch((error: unknown) => {
      console.error(
        "[opencompany] Failed to load plugin setup state for workflow templates",
        error,
      );
      return null;
    }),
  ]);
  const ownerNames = members
    ? {
        // Invite acceptance can create a membership before the member list reflects it, so the
        // viewer is named from their own session rather than trusted to appear in that list.
        [context.user.workosUserId]:
          [context.user.firstName, context.user.lastName].filter(Boolean).join(" ") ||
          context.user.email,
        ...Object.fromEntries(
          members.map((member: WorkspaceMemberView) => [member.userWorkosId, member.name]),
        ),
      }
    : null;
  const templateMissingPlugins = templateSetup
    ? Object.fromEntries(
        WORKFLOW_TEMPLATES.map((template) => [
          template.id,
          workflowTemplateMissingPlugins(template, {
            plugins: templateSetup[0],
            personalAccounts: templateSetup[1],
            companyGitHub: templateSetup[2],
            companySentry: templateSetup[3],
          }),
        ]),
      )
    : null;
  return (
    <WorkflowsRoute
      workflows={workflows}
      workspaceId={context.workspace.id}
      canEdit
      ownerNames={ownerNames}
      templateMissingPlugins={templateMissingPlugins}
      companyGitHub={templateSetup?.[2] ?? null}
      companySentry={templateSetup?.[3] ?? null}
    />
  );
}
