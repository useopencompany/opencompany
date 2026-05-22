import { captureException } from "@opencompany/observability";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { getWorkOSRedirectUri } from "@/lib/workos";

export async function GET() {
  let url: string;
  try {
    url = await getSignInUrl({ redirectUri: getWorkOSRedirectUri() });
  } catch (error) {
    captureException(error, { event: "opencompany.auth_sign_in_url_failed" });
    throw error;
  }
  redirect(url);
}
