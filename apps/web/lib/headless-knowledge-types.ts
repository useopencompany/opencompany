import type {
  BrainDocumentDto,
  BrainDocumentReadModel,
  BrainFolderDto,
  BrainFolderReadModel,
} from "@opencompany/protocol";
import type { GoatBrainDocumentView, GoatBrainFolderView } from "./brain";

export function brainDocumentToView(
  document: BrainDocumentDto | BrainDocumentReadModel,
): GoatBrainDocumentView {
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

export function brainFolderToView(
  folder: BrainFolderDto | BrainFolderReadModel,
): GoatBrainFolderView {
  return {
    ...folder,
    name: folder.path.split("/").at(-1) ?? folder.path,
  };
}
