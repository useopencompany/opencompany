import { redirect } from "next/navigation";
import SignupPanel from "@/components/SignupPanel";
import { currentWorkspace, hasCompletedOnboarding } from "@/lib/auth";

export default async function SignUpPage() {
  const context = await currentWorkspace({ optional: true, skipOnboarding: true });

  if (context) {
    if (!(await hasCompletedOnboarding(context.user))) {
      redirect("/onboarding");
    }

    redirect("/");
  }

  return <SignupPanel />;
}
