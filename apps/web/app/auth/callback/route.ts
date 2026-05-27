import { captureServerEvent } from "@opencompany/analytics/server";
import { captureException } from "@opencompany/observability";
import { handleAuth } from "@workos-inc/authkit-nextjs";

import {
  provisionDefaultOrganization,
  refreshIntoWorkspaceOrganization,
  syncUserAndWorkspace,
} from "@/lib/auth";
import { dispatchSignupWelcomeEmailRequested } from "@/lib/email/events";

export const GET = handleAuth({
  returnPathname: "/onboarding",
  onSuccess: async ({ user, organizationId }) => {
    try {
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

        try {
          await dispatchSignupWelcomeEmailRequested({
            userId: context.user.id,
            workspaceId: context.workspace.id,
            email: context.user.email,
            firstName: context.user.firstName,
            lastName: context.user.lastName,
          });
        } catch (error) {
          captureException(error, {
            event: "opencompany.signup_welcome_email_dispatch_failed",
            user_id: context.user.id,
            workspace_id: context.workspace.id,
          });
        }
      }
    } catch (error) {
      captureException(error, {
        event: "opencompany.auth_callback_failed",
        user_id: user.id,
        organization_id: organizationId,
      });
      throw error;
    }
  },
});
