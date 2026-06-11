import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import {
  hasCompletedOnboarding,
  provisionDefaultOrganization,
  refreshIntoWorkspaceOrganization,
} from "@/lib/auth";
import { isPersonalFirst } from "@/lib/flags/personalFirst";

export async function GET() {
  const session = await withAuth({ ensureSignedIn: true });

  // The root page routes to the user's primary surface (/personal or /company) by their flag, so
  // sending completed users to "/" keeps a single source of truth for that decision.
  if (session.organizationId) {
    redirect("/");
  }

  const context = await provisionDefaultOrganization(session.user);
  await refreshIntoWorkspaceOrganization(context.workspace);

  if (await hasCompletedOnboarding(context.user)) {
    redirect("/");
  }

  redirect(isPersonalFirst(context.user) ? "/onboarding/personal" : "/onboarding");
}
