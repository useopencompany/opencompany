import { handleAuth } from "@workos-inc/authkit-nextjs";
import {
  activateGoatWorkspaceForOrganization,
  adoptWorkOSOrganizationMemberships,
  syncGoatUser,
} from "@/lib/auth";
import { getGoatAppUrl } from "@/lib/workos";

export const GET = handleAuth({
  baseURL: getGoatAppUrl(),
  returnPathname: "/",
  onSuccess: async ({ user, organizationId }) => {
    await syncGoatUser(user);
    await adoptWorkOSOrganizationMemberships(user);
    if (!organizationId) return;

    try {
      await activateGoatWorkspaceForOrganization({
        userWorkosId: user.id,
        organizationId,
      });
    } catch (error) {
      console.error("[goat] Failed to activate the authenticated workspace", error);
    }
  },
});
