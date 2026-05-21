import { redirect } from "next/navigation";
import OnboardingForm from "@/components/OnboardingForm";
import {
  getCurrentWorkspaceWithoutOnboarding,
  hasCompletedOnboarding,
} from "@/lib/auth";

export default async function OnboardingPage() {
  const { authUser, user } = await getCurrentWorkspaceWithoutOnboarding();

  if (await hasCompletedOnboarding(user.id)) {
    redirect("/");
  }

  return <OnboardingForm userEmail={authUser.email} />;
}
