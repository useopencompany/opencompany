import { parseGoatBrainSourceRef } from "@opencompany/goat-brain/schema";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_NUMBER_PATTERN = /^\d+$/;

export function sourceHrefForRef(ref: string): string | null {
  const parsed = parseGoatBrainSourceRef(ref);
  if (!parsed) return null;

  const directUrl = safeExternalUrl(parsed.id);
  if (directUrl) return directUrl;

  switch (parsed.provider) {
    case "github":
      return githubHrefForSourceId(parsed.id);
    case "upload":
      return parsed.id.trim() ? `/api/brain-assets/${encodeURIComponent(parsed.id)}` : null;
    default:
      return null;
  }
}

export function isExternalHref(href: string): boolean {
  return Boolean(safeExternalUrl(href.trim()));
}

export type BrainSourceChip = { icon: "github" | "link"; label: string };

/**
 * Compact, tasteful display for an inline source chip. GitHub PRs/issues collapse
 * to the conventional `#123` with a GitHub mark; the full ref stays available via
 * the chip's tooltip and click target. Everything else keeps its authored label.
 */
export function sourceChipDisplay(ref: string, fallbackLabel: string): BrainSourceChip {
  const parsed = parseGoatBrainSourceRef(ref);
  if (parsed?.provider === "github") {
    const label = githubChipLabel(parsed.id);
    if (label) return { icon: "github", label };
  }
  return { icon: "link", label: fallbackLabel };
}

function githubChipLabel(id: string): string | null {
  const parts = id.split(":");
  const repository = parseGitHubRepository(parts[0] ?? "");
  if (!repository) return null;
  if (parts.length === 1) return `${repository.owner}/${repository.repo}`;

  const kind = parts[1];
  const number = parts[2];
  if ((kind === "pull" || kind === "issue") && number && GITHUB_NUMBER_PATTERN.test(number)) {
    return `#${number}`;
  }
  return `${repository.owner}/${repository.repo}`;
}

function githubHrefForSourceId(id: string): string | null {
  const parts = id.split(":");
  const repository = parseGitHubRepository(parts[0] ?? "");
  if (!repository) return null;

  const repositoryHref = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  if (parts.length === 1) return repositoryHref;
  if (parts.length !== 3 && parts.length !== 5) return null;

  const [, kind, number, commentToken, commentId] = parts;
  if (kind !== "pull" && kind !== "issue") return null;
  if (!number || !GITHUB_NUMBER_PATTERN.test(number)) return null;
  if (parts.length === 5) {
    if (commentToken !== "comment" || !commentId || !GITHUB_NUMBER_PATTERN.test(commentId)) {
      return null;
    }
  }

  const pathKind = kind === "pull" ? "pull" : "issues";
  const hash = commentId ? `#issuecomment-${commentId}` : "";
  return `${repositoryHref}/${pathKind}/${number}${hash}`;
}

function parseGitHubRepository(value: string): { owner: string; repo: string } | null {
  const [owner, repo, ...extra] = value.split("/");
  if (!owner || !repo || extra.length > 0) return null;
  if (!GITHUB_OWNER_PATTERN.test(owner)) return null;
  if (!GITHUB_REPO_PATTERN.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
