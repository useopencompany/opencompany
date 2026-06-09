import { redirect } from "next/navigation";
import PersonalMemoryView from "@/components/PersonalMemoryView";
import { currentWorkspace } from "@/lib/auth";
import { isProMode } from "@/lib/flags/proMode";
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

  const files = await loadPersonalMemoryFiles();

  return <PersonalMemoryView files={files} />;
}
