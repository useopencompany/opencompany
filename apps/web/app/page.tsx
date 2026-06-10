import { redirect } from "next/navigation";
import { currentWorkspace } from "@/lib/auth";
import { isPersonalFirst } from "@/lib/flags/personalFirst";

// Root entry point. currentWorkspace() applies the auth + onboarding gate (redirecting to /signup or
// the appropriate onboarding when needed), then we route to the user's primary surface: the personal
// agent for personal-first users (the default), or the company/workspace surface otherwise.
export default async function RootPage() {
  const { user } = await currentWorkspace();
  redirect(isPersonalFirst(user) ? "/personal" : "/company");
}
