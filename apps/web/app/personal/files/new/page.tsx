"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { PersonalContextFileEditor } from "@/components/personal/PersonalContextFileEditor";
import { personalPaths } from "@/lib/personal/paths";

// Create a new bundle file. An optional ?prefix pre-fills the folder the file lands in. On create
// we merge it into the shared file list and navigate to the new file's editor URL.
function NewFile() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { agent, bundleDir, upsertFile } = usePersonalAgent();
  const prefix = searchParams.get("prefix") ?? "";

  return (
    <div className="h-full overflow-hidden">
      <PersonalContextFileEditor
        agentId={agent.id}
        bundleDir={bundleDir}
        newFilePrefix={prefix}
        onSaved={upsertFile}
        onCreated={(file) => {
          upsertFile(file);
          router.push(personalPaths.file(file.relativePath));
        }}
      />
    </div>
  );
}

export default function PersonalNewFilePage() {
  return (
    <Suspense fallback={null}>
      <NewFile />
    </Suspense>
  );
}
