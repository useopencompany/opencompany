import { agentPathForSlug, agentSlugFromPath, slugifyAgentTitle } from "@opencompany/agent-runtime";

export type AgentRepositoryFile = {
  path: string;
  sha: string | null;
};

export type CanonicalAgentRepositoryFile = {
  path: string;
  canonicalPath: string;
  previousPath: string | null;
  legacyPath: string | null;
  sha: string | null;
};

export function resolveAgentPath(input: {
  title: string;
  existingPaths: Iterable<string>;
  currentPath?: string | null | undefined;
}) {
  const slug = slugifyAgentTitle(input.title);
  const existingSlugs = new Set(
    Array.from(input.existingPaths)
      .filter((path) => path !== input.currentPath)
      .flatMap((path) => {
        const existingSlug = agentSlugFromPath(path);
        return existingSlug ? [existingSlug] : [];
      }),
  );
  let index = 0;

  while (true) {
    const candidateSlug = index === 0 ? slug : `${slug}-${index + 1}`;
    const candidate = agentPathForSlug(candidateSlug);
    if (!existingSlugs.has(candidateSlug)) return candidate;
    index += 1;
  }
}

export function selectCanonicalAgentRepositoryFiles(
  files: AgentRepositoryFile[],
): CanonicalAgentRepositoryFile[] {
  const filesBySlug = new Map<string, CanonicalAgentRepositoryFile>();

  for (const file of files) {
    const slug = agentSlugFromPath(file.path);
    if (!slug) continue;
    const canonicalPath = agentPathForSlug(slug);
    const existing = filesBySlug.get(slug);
    const isCanonical = file.path === canonicalPath;
    if (existing && existing.path === canonicalPath) {
      if (!isCanonical) existing.legacyPath = file.path;
      continue;
    }
    filesBySlug.set(slug, {
      path: file.path,
      canonicalPath,
      previousPath: isCanonical ? null : file.path,
      legacyPath: isCanonical
        ? (existing?.previousPath ?? existing?.legacyPath ?? null)
        : file.path,
      sha: file.sha,
    });
  }

  return Array.from(filesBySlug.values());
}
