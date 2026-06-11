import PersonalBrainLiveView from "@/components/personal/PersonalBrainLiveView";
import { brainInitialPathFromSegments } from "@/lib/brain/paths";
import { loadPersonalBrainFiles, requirePersonalAgentRef } from "@/lib/personal/brain";
import { personalPaths } from "@/lib/personal/paths";

// The personal agent's Personal Brain: the same workspace-Brain UX, scoped to the personal agent's
// bundle personal-brain/ subtree and backed by local-only CRUD (never projected to GitHub).
// URL-addressable via the `[[...path]]` catch-all (mirroring the company Brain): `/personal/brain/<path>`
// opens that file on load and the URL bar reflects the open file/folder.
export default async function PersonalBrainPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path } = await params;
  const initialPath = brainInitialPathFromSegments(path);
  const [files, ref] = await Promise.all([loadPersonalBrainFiles(), requirePersonalAgentRef()]);

  return (
    <PersonalBrainLiveView
      files={files}
      bundleDir={ref.bundleDir}
      initialPath={initialPath}
      urlBasePath={personalPaths.brain}
    />
  );
}
