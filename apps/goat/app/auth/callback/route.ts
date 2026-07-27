import { handleAuth } from "@workos-inc/authkit-nextjs";
import { adoptWorkOSOrganizationMemberships, syncGoatUser } from "@/lib/auth";
import { getGoatAppUrl } from "@/lib/workos";

export const GET = handleAuth({
  baseURL: getGoatAppUrl(),
  returnPathname: "/",
  onSuccess: async ({ user }) => {
    await syncGoatUser(user);
    await adoptWorkOSOrganizationMemberships(user);
  },
});
