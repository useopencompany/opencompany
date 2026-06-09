import BrainView from "@/components/BrainView";
import {
  createPersonalBrainFile,
  deletePersonalBrainFile,
  deletePersonalBrainFolder,
  renamePersonalBrainFile,
  renamePersonalBrainFolder,
  updatePersonalBrainFile,
} from "@/lib/personal/brain-actions";
import { loadPersonalBrainFiles } from "@/lib/personal/brain";

// The personal agent's Personal Brain: the same workspace-Brain UX, scoped to the personal agent's
// bundle personal-brain/ subtree and backed by local-only CRUD (never projected to GitHub).
export default async function PersonalBrainPage() {
  const files = await loadPersonalBrainFiles();

  return (
    <BrainView
      files={files}
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
