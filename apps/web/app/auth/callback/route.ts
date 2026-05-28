import { captureServerEvent } from "@opencompany/analytics/server";
import { captureException } from "@opencompany/observability";
import { handleAuth } from "@workos-inc/authkit-nextjs";

import {
  provisionDefaultOrganization,
  refreshIntoWorkspaceOrganization,
  syncUserAndWorkspace,
} from "@/lib/auth";
import { dispatchSignupWelcomeEmailRequested } from "@/lib/email/events";

function readJwtPayload(accessToken: string): Record<string, unknown> {
  // AuthKit invokes this callback after the server-side token exchange. We only
  // decode the already-trusted access token here to read WorkOS role claims.
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return {};
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function workosRoleFromAccessToken(accessToken: string) {
  const payload = readJwtPayload(accessToken);
  if (typeof payload.role === "string") return payload.role;
  if (Array.isArray(payload.roles) && typeof payload.roles[0] === "string") return payload.roles[0];
  return undefined;
}

export const GET = handleAuth({
  returnPathname: "/onboarding",
  onSuccess: async ({ user, organizationId, accessToken }) => {
    try {
      const context = organizationId
        ? await syncUserAndWorkspace(user, organizationId, workosRoleFromAccessToken(accessToken))
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
