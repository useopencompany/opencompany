import { getSignUpUrl, withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { getConnectorWorkOSRedirectUri } from "@/lib/workos";

export async function GET() {
  const { user } = await withAuth();

  if (user) {
    redirect("/setup");
  }

  const url = await getSignUpUrl({ redirectUri: getConnectorWorkOSRedirectUri() });
  redirect(url);
}
