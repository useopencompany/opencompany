import { handleAuth } from "@workos-inc/authkit-nextjs";
import { syncConnectorUser } from "@/lib/auth";

export const GET = handleAuth({
  returnPathname: "/setup",
  onSuccess: async ({ user }) => {
    await syncConnectorUser(user);
  },
});
