"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useMemo } from "react";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { PersonalContextFileEditor } from "@/components/personal/PersonalContextFileEditor";
import { personalPaths, relativePathFromSegments } from "@/lib/personal/paths";

// Editor for an existing bundle file. The [...path] segments reconstruct the real relative path
// (e.g. memory/notes.md). If the file was deleted out from under us, fall back to the home view.
export default function PersonalFilePage({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = use(params);
  const router = useRouter();
  const { agent, bundleDir, files, upsertFile } = usePersonalAgent();

  const relativePath = useMemo(() => relativePathFromSegments(path), [path]);
  const file = useMemo(
    () => files.find((candidate) => candidate.relativePath === relativePath),
    [files, relativePath],
  );

  useEffect(() => {
    if (!file) router.replace(personalPaths.home);
  }, [file, router]);

  if (!file) return null;

  return (
    <div className="h-full overflow-hidden">
      <PersonalContextFileEditor
        agentId={agent.id}
        bundleDir={bundleDir}
        file={file}
        onSaved={upsertFile}
        onCreated={(saved) => router.push(personalPaths.file(saved.relativePath))}
      />
    </div>
  );
}
