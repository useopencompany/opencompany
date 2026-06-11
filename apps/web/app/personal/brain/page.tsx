import PersonalBrainLiveView from "@/components/personal/PersonalBrainLiveView";
import { loadPersonalBrainFiles, requirePersonalAgentRef } from "@/lib/personal/brain";

// The personal agent's Personal Brain: the same workspace-Brain UX, scoped to the personal agent's
// bundle personal-brain/ subtree and backed by local-only CRUD (never projected to GitHub).
export default async function PersonalBrainPage() {
  const [files, ref] = await Promise.all([loadPersonalBrainFiles(), requirePersonalAgentRef()]);

  return <PersonalBrainLiveView files={files} bundleDir={ref.bundleDir} />;
}
