export function fileNameFromPath(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function brainFileRenameSelectionEnd(fileName: string) {
  const extensionStart = fileName.lastIndexOf(".");
  if (extensionStart <= 0) return fileName.length;
  return extensionStart;
}

export function resolveBrainFileRenameName(originalName: string, inputName: string) {
  const nextName = inputName.trim();
  if (!nextName) return nextName;
  if (nextName.includes(".")) return nextName;

  const extensionStart = brainFileRenameSelectionEnd(originalName);
  const extension = originalName.slice(extensionStart);
  return extension ? `${nextName}${extension}` : nextName;
}
