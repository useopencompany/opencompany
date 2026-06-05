import type { AgentBrainReference } from "./types";

export const BRAIN_SYNC_DELAY_MS = 10_000;

/**
 * Whether a Brain file path (relative to the Brain root, i.e. without the
 * `brain/` prefix) is covered by a single Brain reference. Folder references
 * match by prefix — so new files created inside the folder are allowed — while
 * file references match exactly. The root reference (`/`) matches everything.
 *
 * This is the single source of truth for Brain access scope: it governs which
 * files get materialized into a session, which writes sync back to the canonical
 * store, and which tool-layer file operations are permitted.
 */
export function matchesBrainReference(path: string, reference: AgentBrainReference): boolean {
  if (reference.type === "folder" && reference.path === "/") return true;
  return reference.type === "folder" ? path.startsWith(reference.path) : path === reference.path;
}

/** Whether any reference covers the given Brain-relative file path. */
export function isBrainPathAllowed(path: string, references: AgentBrainReference[]): boolean {
  return references.some((reference) => matchesBrainReference(path, reference));
}

/**
 * Whether a Brain directory (relative to the Brain root, `""` for the root) may
 * be listed given the references. A directory is listable when it is the root,
 * an ancestor of a reference (so the agent can navigate down toward an allowed
 * folder), or itself inside a folder reference.
 */
export function isBrainListingAllowed(dirPath: string, references: AgentBrainReference[]): boolean {
  const dir = dirPath === "" || dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
  return references.some((reference) => {
    if (reference.path === "/") return true;
    if (dir === "") return true;
    return reference.path.startsWith(dir) || matchesBrainReference(dirPath, reference);
  });
}

/** Render a reference path for display in prompts/errors, e.g. `brain/wiki/`. */
export function formatBrainReferenceDisplay(path: string): string {
  return path === "/" ? "brain/" : `brain/${path}`;
}
