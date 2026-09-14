import { TasksWorkflowsDisabledRoute, WorkflowsRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { listHeadlessWorkflows } from "@/lib/headless-automation-server";
import { listWorkspaceMembersAction, type WorkspaceMemberView } from "@/lib/workspace-actions";

export default async function WorkflowsPage() {
  const context = await currentUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  // The API only returns company workflows plus this user's personal ones, so every row here is
  // one they can open and edit. Owner names only decorate that list, so a workspace-settings
  // failure degrades the Owner column rather than taking the whole page down with it.
  const [workflows, members] = await Promise.all([
    listHeadlessWorkflows(),
    listWorkspaceMembersAction().catch((error: unknown) => {
      console.error("[opencompany] Failed to load workspace members for the workflow list", error);
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
  return (
    <WorkflowsRoute
      workflows={workflows}
      workspaceId={context.workspace.id}
      canEdit
      ownerNames={ownerNames}
    />
  );
}
