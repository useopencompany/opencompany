import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { getGoatWorkOSRedirectUri } from "@/lib/workos";

export async function GET() {
  redirect(await getSignInUrl({ redirectUri: getGoatWorkOSRedirectUri() }));
}
