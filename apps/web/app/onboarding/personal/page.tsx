import { PersonalOnboardingChat } from "@/components/personal/PersonalOnboardingChat";
import { currentWorkspace } from "@/lib/auth";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";

// V2 onboarding: the personal agent's chatbox, nothing else. `ensurePersonalAgent` is idempotent
// (the layout already called it), so this just resolves the agent so we can hand its id to the
// client composer.
export default async function PersonalOnboardingPage() {
  const { authUser, user, workspace } = await currentWorkspace();

  const agentName = user.firstName?.trim() || authUser.email.split("@")[0] || "You";
  const agent = await ensurePersonalAgent({
    userId: user.id,
    workspaceId: workspace.id,
    name: agentName,
  });

  const defaultName = user.firstName?.trim() || "";

  return (
    <PersonalOnboardingChat
      agentId={agent.id}
      defaultName={defaultName}
      devReset={process.env.NODE_ENV !== "production"}
    />
  );
}
