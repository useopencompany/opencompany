import { PersonalOnboardingChat } from "@/components/personal/PersonalOnboardingChat";
import { currentWorkspace } from "@/lib/auth";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";

// V2 onboarding: the personal agent's chatbox, nothing else. `ensurePersonalAgent` is idempotent
// (the layout already called it), so this just resolves the agent so we can hand its id to the
// client composer.
export default async function PersonalOnboardingPage() {
  const { authUser, user, workspace } = await currentWorkspace({ skipOnboarding: true });

  const userName = user.firstName?.trim() || authUser.email.split("@")[0] || "you";
  const agent = await ensurePersonalAgent({
    userId: user.id,
    workspaceId: workspace.id,
    userName,
  });

  // Prefill the name field from the WorkOS profile captured at sign-up (first + last
  // when available, otherwise whichever we have).
  const defaultName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() ||
    user.firstName?.trim() ||
    "";

  return (
    <PersonalOnboardingChat
      agentId={agent.id}
      defaultName={defaultName}
      userEmail={authUser.email}
    />
  );
}
