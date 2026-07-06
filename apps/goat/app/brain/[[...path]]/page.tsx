import { GoatBrainView } from "@/components/GoatBrainView";
import { listCurrentUserGoatBrain } from "@/lib/brain";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ path?: string[] }>;
};

export default async function GoatBrainPage({ params }: PageProps) {
  const [{ path }, brain] = await Promise.all([params, listCurrentUserGoatBrain()]);
  const segments = path ?? [];
  const requestedPath = segments.join("/");
  const requestedFolderExists = brain.folders.some((folder) => folder.path === requestedPath);
  const initialBrainId =
    segments.length > 1 && !requestedFolderExists ? (segments.at(-1) ?? null) : null;
  const initialFolderPath =
    segments.length > 0
      ? initialBrainId
        ? segments.slice(0, -1).join("/")
        : requestedPath
      : (brain.folders[0]?.path ?? null);

  return (
    <GoatBrainView
      folders={brain.folders}
      documents={brain.documents}
      initialFolderPath={initialFolderPath || null}
      initialBrainId={initialBrainId}
    />
  );
}
