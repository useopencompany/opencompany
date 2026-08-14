import type { BrainDocumentView } from "@opencompany/agent/brain-files";
import type {
  BrainDocumentDto,
  BrainDocumentReadModel,
  BrainFolderDto,
  BrainFolderReadModel,
  BrainOverviewDto,
} from "@opencompany/protocol";

export type { BrainDocumentView } from "@opencompany/agent/brain-files";

export type BrainFolderView = BrainFolderDto & { name: string };

export type BrainSnapshot = {
  folders: BrainFolderView[];
  documents: BrainDocumentView[];
};

export type BrainOverviewStats = BrainOverviewDto;

export function brainDocumentToView(
  document: BrainDocumentDto | BrainDocumentReadModel,
): BrainDocumentView {
  const { createdByActorId, ...canonical } = document;
  return {
    ...canonical,
    // Electric update entries can contain only folderPath. Derive path at the presentation edge
    // so a folder move never leaves the existing row's computed path stale.
    path: `${document.folderPath}/${document.brainId}.md`,
    parseError: null,
    createdByWorkosId: createdByActorId,
  };
}

export function brainFolderToView(folder: BrainFolderDto | BrainFolderReadModel): BrainFolderView {
  return {
    ...folder,
    name: folder.path.split("/").at(-1) ?? folder.path,
  };
}
