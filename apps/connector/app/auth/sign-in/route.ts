import { getSignInUrl, withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { redirectToConnectorHomeForAuthUser } from "@/lib/auth";
import { getConnectorWorkOSRedirectUri } from "@/lib/workos";

export async function GET() {
  const { user } = await withAuth();

  if (user) {
    await redirectToConnectorHomeForAuthUser(user);
  }

  const url = await getSignInUrl({ redirectUri: getConnectorWorkOSRedirectUri() });
  redirect(url);
}
