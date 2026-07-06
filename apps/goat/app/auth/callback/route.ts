import { handleAuth } from "@workos-inc/authkit-nextjs";
import { syncGoatUser } from "@/lib/auth";

export const GET = handleAuth({
  returnPathname: "/",
  onSuccess: async ({ user }) => {
    await syncGoatUser(user);
  },
});
