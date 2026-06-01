import { agentBundleDir, agentDefinitionFileNameForPath } from "@opencompany/agent-runtime";
import type { AgentFile } from "@opencompany/db/schema";

export type AgentBundleFilePayload = {
  path: string;
  relativePath: string;
  content: string;
  sizeBytes: number;
  contentHash: string;
  githubCommitSha: string | null;
  githubSyncedAt: string | null;
  githubSyncStatus: string;
  githubSyncError: string | null;
  updatedAt: string;
};

export function serializeAgentBundleFiles(agentPath: string | null, files: AgentFile[]) {
  if (!agentPath) return [];
  const bundleDir = agentBundleDir(agentPath);
  const definitionFileName = agentDefinitionFileNameForPath(agentPath);
  return files
    .flatMap((file) => {
      const relativePath = agentBundleRelativePath(file.path, bundleDir);
      if (!relativePath || relativePath === "agent.agent" || relativePath === definitionFileName) {
        return [];
      }
      return [
        {
          path: file.path,
          relativePath,
          content: file.content,
          sizeBytes: file.sizeBytes,
          contentHash: file.contentHash,
          githubCommitSha: file.githubCommitSha,
          githubSyncedAt: file.githubSyncedAt?.toISOString() ?? null,
          githubSyncStatus: file.githubSyncStatus,
          githubSyncError: file.githubSyncError,
          updatedAt: file.updatedAt.toISOString(),
        },
      ];
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function agentBundleRelativePath(path: string, bundleDir: string) {
  const prefix = `${bundleDir}/`;
  if (!path.startsWith(prefix)) return null;
  return normalizeAgentBundleRelativePath(path.slice(prefix.length));
}

export function normalizeAgentBundleRelativePath(input: string) {
  const path = input.trim().replace(/^\/+/, "").split("/").filter(Boolean).join("/");
  if (!path || path === "/" || path.startsWith(".") || path.includes("..")) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)) return null;
  return path;
}

export function isAgentBundleTextFile(path: string) {
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mov|mp3|woff2?)$/i.test(path);
}
