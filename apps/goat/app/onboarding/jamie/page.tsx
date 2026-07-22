import { redirect } from "next/navigation";

// Jamie now connects inside the onboarding wizard's connect modal. This route
// is kept only so any stale links land back on the sources step.
export default function OnboardingJamiePage() {
  redirect("/onboarding");
}
