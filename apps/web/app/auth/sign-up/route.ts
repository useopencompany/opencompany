import { captureException } from "@opencompany/observability";
import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

import { getWorkOSRedirectUri } from "@/lib/workos";

export async function GET() {
  let url: string;
  try {
    url = await getSignUpUrl({ redirectUri: getWorkOSRedirectUri() });
  } catch (error) {
    captureException(error, { event: "opencompany.auth_sign_up_url_failed" });
    throw error;
  }
  redirect(url);
}
