"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { useCollections } from "@/components/CollectionsProvider";
import PersonalMemoryView from "@/components/PersonalMemoryView";
import { derivePersonalFilesFromAgentRows } from "@/lib/collections/selectors";
import type { PersonalBrainFile } from "@/lib/personal/brain";

type PersonalMemoryLiveViewProps = {
  files: PersonalBrainFile[];
  bundleDir: string;
};

export default function PersonalMemoryLiveView({ files, bundleDir }: PersonalMemoryLiveViewProps) {
  const { personalAgentFiles } = useCollections();
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ file: personalAgentFiles }));
  const prefix = personalMemoryPrefix(bundleDir);
  const liveFiles = useMemo(
    () => derivePersonalFilesFromAgentRows(rows ?? [], prefix),
    [rows, prefix],
  );

  return <PersonalMemoryView files={isLoading ? files : liveFiles} />;
}

function personalMemoryPrefix(bundleDir: string) {
  return `${bundleDir}/memory/`;
}
