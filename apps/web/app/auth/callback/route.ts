import { handleAuth } from "@workos-inc/authkit-nextjs";

import { syncUserAndWorkspace } from "@/lib/auth";

export const GET = handleAuth({
  returnPathname: "/onboarding",
  onSuccess: async ({ user }) => {
    await syncUserAndWorkspace(user);
  },
});
