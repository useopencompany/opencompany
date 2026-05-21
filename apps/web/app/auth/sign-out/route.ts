import { captureServerEvent } from "@opencompany/analytics/server";
import { signOut } from "@workos-inc/authkit-nextjs";
import { getOptionalCurrentWorkspaceWithoutOnboarding } from "@/lib/auth";

function signOutSource(request: Request) {
  const referer = request.headers.get("referer");
  if (!referer) return "direct";

  try {
    const pathname = new URL(referer).pathname;
    if (pathname === "/onboarding") return "onboarding_switch_email";
    if (pathname === "/settings") return "settings";
  } catch {
    return "direct";
  }

  return "direct";
}

export async function GET(request: Request) {
  const context = await getOptionalCurrentWorkspaceWithoutOnboarding();
  if (context) {
    await captureServerEvent("sign_out", context.user.id, {
      user_id: context.user.id,
      workspace_id: context.workspace.id,
      source: signOutSource(request),
    });
  }

  await signOut({ returnTo: new URL("/signup", request.url).toString() });
}
