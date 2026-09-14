import { Directory, File, Paths } from "expo-file-system";
export function attachmentDirectory(): Directory {
  return new Directory(Paths.document, "chat-attachments");
}
export function deleteFiles(uris: string[]): void {
  for (const uri of uris) {
    const file = new File(uri);
    if (file.exists) file.delete();
  }
}
