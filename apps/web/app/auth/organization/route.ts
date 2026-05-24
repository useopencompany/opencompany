import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import {
  hasCompletedOnboarding,
  provisionDefaultOrganization,
  refreshIntoWorkspaceOrganization,
} from "@/lib/auth";

export async function GET() {
  const session = await withAuth({ ensureSignedIn: true });

  if (session.organizationId) {
    redirect("/");
  }

  const context = await provisionDefaultOrganization(session.user);
  await refreshIntoWorkspaceOrganization(context.workspace);

  if (await hasCompletedOnboarding(context.user)) {
    redirect("/");
  }

  redirect("/onboarding");
}
