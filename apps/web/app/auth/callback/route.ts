import { captureServerEvent } from "@opencompany/analytics/server";
import { handleAuth } from "@workos-inc/authkit-nextjs";

import { syncUserAndWorkspace } from "@/lib/auth";

export const GET = handleAuth({
  returnPathname: "/onboarding",
  onSuccess: async ({ user }) => {
    const context = await syncUserAndWorkspace(user);
    if (context.isNewUser) {
      await captureServerEvent("signup_completed", context.user.id, {
        user_id: context.user.id,
        workspace_id: context.workspace.id,
      });
    }
  },
});
