"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import BrainView, { type BrainActionResult, type BrainActions } from "@/components/BrainView";
import { useCollections } from "@/components/CollectionsProvider";
import { MAX_BRAIN_FILE_BYTES, normalizeBrainPath } from "@/lib/brain/paths";
import type { Collections } from "@/lib/collections";
import { derivePersonalFilesFromAgentRows } from "@/lib/collections/selectors";
import type { PersonalBrainFile } from "@/lib/personal/brain";

type PersonalBrainLiveViewProps = {
  files: PersonalBrainFile[];
  bundleDir: string;
  initialPath?: string;
  urlBasePath?: string;
};

type PersonalAgentFilesCollection = Collections["personalAgentFiles"];
type PersonalBrainTransaction = ReturnType<PersonalAgentFilesCollection["insert"]>;

export default function PersonalBrainLiveView({
  files,
  bundleDir,
  initialPath,
  urlBasePath,
}: PersonalBrainLiveViewProps) {
  const { personalAgentFiles } = useCollections();
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ file: personalAgentFiles }));
  const prefix = personalBrainPrefix(bundleDir);
  const liveFiles = useMemo(
    () => derivePersonalFilesFromAgentRows(rows ?? [], prefix),
    [rows, prefix],
  );
  const visibleFiles = isLoading ? files : liveFiles;
  const actions = useMemo(
    () => createPersonalBrainActions(personalAgentFiles, visibleFiles, bundleDir),
    [personalAgentFiles, visibleFiles, bundleDir],
  );

  return (
    <BrainView
      files={visibleFiles}
      initialPath={initialPath ?? ""}
      {...(urlBasePath ? { urlBasePath } : {})}
      title="Personal brain"
      emptyHint="Create a Personal Brain note to start saving your private knowledge."
      actions={actions}
      refreshOnAction={false}
    />
  );
}

function createPersonalBrainActions(
  collection: PersonalAgentFilesCollection,
  files: PersonalBrainFile[],
  bundleDir: string,
): BrainActions {
  return {
    createFile: (path, content = "") => {
      const normalized = normalizeBrainPath(path);
      const repoPath = personalBrainRepoPath(bundleDir, normalized);
      if (files.some((file) => file.path === normalized)) {
        return Promise.resolve({
          ok: false,
          error: "A Personal Brain file already exists at this path.",
        });
      }
      const sizeBytes = brainContentSize(content);
      if (sizeBytes > MAX_BRAIN_FILE_BYTES) {
        return Promise.resolve({
          ok: false,
          error: "Personal Brain files must be 256 KB or smaller.",
        });
      }
      const now = new Date().toISOString();
      const tx = collection.insert({
        id: optimisticId(),
        workspace_id: "",
        agent_id: "",
        path: repoPath,
        content,
        content_hash: "optimistic",
        size_bytes: sizeBytes,
        github_blob_sha: null,
        github_commit_sha: null,
        github_synced_hash: null,
        github_synced_at: null,
        github_sync_status: "synced",
        github_sync_error: null,
        created_at: now,
        updated_at: now,
      });
      return txToBrainResult(tx, normalized);
    },
    updateFile: (path, content) => {
      const file = findFile(files, path);
      if (!file?.id) return Promise.resolve({ ok: false, error: "Personal Brain file not found." });
      const sizeBytes = brainContentSize(content);
      if (sizeBytes > MAX_BRAIN_FILE_BYTES) {
        return Promise.resolve({
          ok: false,
          error: "Personal Brain files must be 256 KB or smaller.",
        });
      }
      const tx = collection.update(file.id, (draft) => {
        draft.content = content;
        draft.content_hash = "optimistic";
        draft.size_bytes = sizeBytes;
        draft.github_sync_status = "synced";
        draft.github_sync_error = null;
        draft.updated_at = new Date().toISOString();
      });
      return txToBrainResult(tx, file.path);
    },
    renameFile: (fromPath, toPath) => {
      const file = findFile(files, fromPath);
      if (!file?.id) return Promise.resolve({ ok: false, error: "Personal Brain file not found." });
      const normalized = normalizeBrainPath(toPath);
      if (files.some((candidate) => candidate.path === normalized && candidate.id !== file.id)) {
        return Promise.resolve({
          ok: false,
          error: "A Personal Brain file already exists at that path.",
        });
      }
      const tx = collection.update(file.id, (draft) => {
        draft.path = personalBrainRepoPath(bundleDir, normalized);
        draft.updated_at = new Date().toISOString();
      });
      return txToBrainResult(tx, normalized);
    },
    renameFolder: (fromPath, toPath) => {
      const from = normalizeFolderPath(fromPath);
      const to = normalizeFolderPath(toPath);
      if (to.startsWith(`${from}/`)) {
        return Promise.resolve({ ok: false, error: "Folders cannot be moved inside themselves." });
      }
      const moving = files.filter((file) => file.path.startsWith(`${from}/`));
      if (moving.length === 0) {
        return Promise.resolve({ ok: false, error: "Personal Brain folder not found." });
      }
      const movingIds = new Set(moving.map((file) => file.id));
      for (const file of moving) {
        const nextPath = `${to}/${file.path.slice(from.length + 1)}`;
        if (
          files.some((candidate) => candidate.path === nextPath && !movingIds.has(candidate.id))
        ) {
          return Promise.resolve({
            ok: false,
            error: `A Personal Brain file already exists at ${nextPath}.`,
          });
        }
      }
      const tx = collection.update(
        moving.map((file) => file.id).filter((id): id is number => typeof id === "number"),
        (drafts) => {
          for (const draft of drafts) {
            const current = files.find((file) => file.id === draft.id);
            if (!current) continue;
            draft.path = personalBrainRepoPath(
              bundleDir,
              `${to}/${current.path.slice(from.length + 1)}`,
            );
            draft.updated_at = new Date().toISOString();
          }
        },
      );
      return txToBrainResult(tx, to);
    },
    deleteFile: (path) => {
      const file = findFile(files, path);
      if (!file?.id) return Promise.resolve({ ok: false, error: "Personal Brain file not found." });
      const tx = collection.delete(file.id);
      return txToBrainResult(tx, file.path);
    },
    deleteFolder: (path) => {
      const folderPath = normalizeFolderPath(path);
      const ids = files
        .filter((file) => file.path.startsWith(`${folderPath}/`))
        .map((file) => file.id)
        .filter((id): id is number => typeof id === "number");
      if (ids.length === 0) {
        return Promise.resolve({ ok: false, error: "Personal Brain folder not found." });
      }
      const tx = collection.delete(ids);
      return txToBrainResult(tx, folderPath);
    },
  };
}

async function txToBrainResult(
  tx: PersonalBrainTransaction,
  path: string,
): Promise<BrainActionResult> {
  try {
    await tx.isPersisted.promise;
    return { ok: true, path };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Personal Brain update failed.",
    };
  }
}

function findFile(files: PersonalBrainFile[], path: string) {
  const normalized = normalizeBrainPath(path);
  return files.find((file) => file.path === normalized);
}

function normalizeFolderPath(path: string) {
  return normalizeBrainPath(`${path.replace(/\/+$/g, "")}/`, { allowFolder: true }).replace(
    /\/$/g,
    "",
  );
}

function personalBrainRepoPath(bundleDir: string, logicalPath: string) {
  return `${bundleDir}/personal-brain/${logicalPath}`;
}

function personalBrainPrefix(bundleDir: string) {
  return `${bundleDir}/personal-brain/`;
}

function brainContentSize(content: string) {
  return new TextEncoder().encode(content).byteLength;
}

function optimisticId() {
  return -Math.floor(Date.now() + Math.random() * 1_000_000);
}
