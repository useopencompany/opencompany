import { redirect } from "next/navigation";
import { currentWorkspace } from "@/lib/auth";
import { isPersonalFirst } from "@/lib/flags/personalFirst";

type RootPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function hasOnboardingFlag(searchParams: RootPageProps["searchParams"]) {
  const params = await searchParams;
  return Object.hasOwn(params, "onboarding");
}

// Root entry point. currentWorkspace() applies the auth + onboarding gate (redirecting to /signup or
// the appropriate onboarding when needed), then we route to the user's primary surface: the personal
// agent for personal-first users (the default), or the company/workspace surface otherwise.
export default async function RootPage({ searchParams }: RootPageProps) {
  const forceOnboarding = await hasOnboardingFlag(searchParams);
  const { user } = await currentWorkspace({ skipOnboarding: forceOnboarding });
  const personalFirst = isPersonalFirst(user);

  if (forceOnboarding) {
    redirect("/onboarding?onboarding=1");
  }

  redirect(personalFirst ? "/personal" : "/company");
}
