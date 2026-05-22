import { captureServerEvent } from "@opencompany/analytics/server";
import { handleAuth } from "@workos-inc/authkit-nextjs";

import {
  provisionDefaultOrganization,
  refreshIntoWorkspaceOrganization,
  syncUserAndWorkspace,
} from "@/lib/auth";

export const GET = handleAuth({
  returnPathname: "/onboarding",
  onSuccess: async ({ user, organizationId }) => {
    const context = organizationId
      ? await syncUserAndWorkspace(user, organizationId, "admin")
      : await provisionDefaultOrganization(user);

    if (!organizationId) {
      await refreshIntoWorkspaceOrganization(context.workspace);
    }

    if (context.isNewUser) {
      await captureServerEvent("signup_completed", context.user.id, {
        user_id: context.user.id,
        workspace_id: context.workspace.id,
      });
    }
  },
});
