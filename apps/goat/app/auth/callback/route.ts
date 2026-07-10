import { handleAuth } from "@workos-inc/authkit-nextjs";
import { syncGoatUser } from "@/lib/auth";
import { getGoatAppUrl } from "@/lib/workos";

export const GET = handleAuth({
  baseURL: getGoatAppUrl(),
  returnPathname: "/",
  onSuccess: async ({ user }) => {
    await syncGoatUser(user);
  },
});
