// Central path builder for the /personal surface. Every sub-view of the personal agent gets a
// real URL here, so adding a new view is "new route directory + one entry below" — no client-side
// view-state machine. Keep this the single source of truth for personal URLs; components link
// through `personalPaths.*` rather than hand-writing `/personal/...` strings.

export type PersonalPanel =
  | "agent"
  | "skills"
  | "integrations"
  | "tools"
  | "channels"
  | "brain"
  | "memory"
  | "settings";

export const personalPaths = {
  home: "/personal",
  session: (id: string) => `/personal/session/${id}`,
  agent: "/personal/agent",
  soul: "/personal/files/soul.md",
  brain: "/personal/brain",
  memory: "/personal/memory",
  settings: "/personal/settings",
  skills: "/personal/skills",
  integrations: "/personal/integrations",
  tools: "/personal/tools",
  channels: "/personal/channels",
  // A bundle file lives at its real relative path (e.g. "memory/notes.md"); encode each segment
  // so the [...path] route round-trips slashes and reserved characters cleanly.
  file: (relativePath: string) =>
    `/personal/files/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
  newFile: (prefix?: string) =>
    prefix ? `/personal/files/new?prefix=${encodeURIComponent(prefix)}` : "/personal/files/new",
} as const;

// Reconstruct a bundle relative path from the [...path] catch-all segments (Next already decodes
// each segment). Mirrors `personalPaths.file`.
export function relativePathFromSegments(segments: string[]): string {
  return segments.join("/");
}
