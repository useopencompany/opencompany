import { redirect } from "next/navigation";
import PersonalMemoryLiveView from "@/components/personal/PersonalMemoryLiveView";
import { currentWorkspace } from "@/lib/auth";
import { isProMode } from "@/lib/flags/proMode";
import { requirePersonalAgentRef } from "@/lib/personal/brain";
import { loadPersonalMemoryFiles } from "@/lib/personal/memory";
import { personalPaths } from "@/lib/personal/paths";

// The personal agent's Memory inspector — a read-only view of the agent's tool-maintained
// understanding (`memory/` bundle subtree). Gated behind per-user Pro mode: when it's off the
// surface is hidden in the sidebar, so a direct hit here bounces back to the Agent page.
export default async function PersonalMemoryPage() {
  const { user } = await currentWorkspace();
  if (!isProMode(user)) {
    redirect(personalPaths.agent);
  }

  const [files, ref] = await Promise.all([loadPersonalMemoryFiles(), requirePersonalAgentRef()]);

  return <PersonalMemoryLiveView files={files} bundleDir={ref.bundleDir} />;
}
