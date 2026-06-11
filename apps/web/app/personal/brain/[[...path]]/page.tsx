import BrainView from "@/components/BrainView";
import { brainInitialPathFromSegments } from "@/lib/brain/paths";
import { loadPersonalBrainFiles } from "@/lib/personal/brain";
import {
  createPersonalBrainFile,
  deletePersonalBrainFile,
  deletePersonalBrainFolder,
  renamePersonalBrainFile,
  renamePersonalBrainFolder,
  updatePersonalBrainFile,
} from "@/lib/personal/brain-actions";
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
  const files = await loadPersonalBrainFiles();

  return (
    <BrainView
      files={files}
      initialPath={initialPath}
      urlBasePath={personalPaths.brain}
      title="Personal brain"
      emptyHint="Create a Personal Brain note to start saving your private knowledge."
      actions={{
        createFile: createPersonalBrainFile,
        updateFile: updatePersonalBrainFile,
        renameFile: renamePersonalBrainFile,
        renameFolder: renamePersonalBrainFolder,
        deleteFile: deletePersonalBrainFile,
        deleteFolder: deletePersonalBrainFolder,
      }}
    />
  );
}
