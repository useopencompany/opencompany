import { redirect } from "next/navigation";
import { AnalyticsProvider } from "@opencompany/analytics/client";
import OnboardingForm from "@/components/OnboardingForm";
import {
  getCurrentWorkspaceWithoutOnboarding,
  hasCompletedOnboarding,
} from "@/lib/auth";

export default async function OnboardingPage() {
  const { authUser, user, workspace } = await getCurrentWorkspaceWithoutOnboarding();

  if (await hasCompletedOnboarding(user.id)) {
    redirect("/");
  }

  return (
    <AnalyticsProvider
      identity={{
        userId: user.id,
        workspaceId: workspace.id,
        email: authUser.email,
        firstName: authUser.firstName,
        lastName: authUser.lastName,
      }}
    >
      <OnboardingForm
        userEmail={authUser.email}
        userId={user.id}
        workspaceId={workspace.id}
      />
    </AnalyticsProvider>
  );
}
