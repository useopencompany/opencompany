import { redirect } from "next/navigation";
import SignupPanel from "@/components/SignupPanel";
import { getOptionalCurrentWorkspaceWithoutOnboarding, hasCompletedOnboarding } from "@/lib/auth";

export default async function SignUpPage() {
  const context = await getOptionalCurrentWorkspaceWithoutOnboarding();

  if (context) {
    if (!(await hasCompletedOnboarding(context.user))) {
      redirect("/onboarding");
    }

    redirect("/");
  }

  return <SignupPanel />;
}
