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
    case "linear":
      return linearHrefForSourceId(parsed.id);
    case "gmail":
      return gmailHrefForSourceId(parsed.id);
    case "slack":
      return slackHrefForSourceId(parsed.id);
    case "google-drive":
      return googleDriveHrefForSourceId(parsed.id);
    case "hubspot":
      return hubspotHrefForSourceId(parsed.id);
    case "fathom":
      return fathomHrefForSourceId(parsed.id);
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
  // Linear issues collapse to their identifier when the ref was authored with a
  // raw-ref label ("linear:issue:ENG-123" reads as "ENG-123").
  if (parsed?.provider === "linear" && fallbackLabel === ref) {
    const identifier = linearIdentifierForSourceId(parsed.id);
    if (identifier) return { icon: "link", label: identifier };
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

// Resolvers below construct URLs only from tightly validated ids — a ref that
// does not match its provider's grammar renders as a dead chip rather than a
// link to an attacker-shaped URL.

const LINEAR_IDENTIFIER_PATTERN = /^[A-Za-z0-9]+-\d+$/;
const GMAIL_THREAD_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const SLACK_TEAM_PATTERN = /^[TE][A-Z0-9]{6,20}$/;
const SLACK_CHANNEL_PATTERN = /^[CDG][A-Z0-9]{6,20}$/;
const DRIVE_FILE_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;
const HUBSPOT_NUMERIC_PATTERN = /^\d{1,20}$/;
const FATHOM_RECORDING_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HUBSPOT_OBJECT_TYPE_IDS: Record<string, string> = {
  contact: "0-1",
  company: "0-2",
  deal: "0-3",
};

function linearIdentifierForSourceId(id: string): string | null {
  const parts = id.split(":");
  if (parts.length !== 2 || parts[0] !== "issue") return null;
  const identifier = parts[1] ?? "";
  return LINEAR_IDENTIFIER_PATTERN.test(identifier) ? identifier.toUpperCase() : null;
}

// linear:issue:ENG-123 — Linear resolves /issue/<identifier> to the viewer's
// workspace when they are signed in.
function linearHrefForSourceId(id: string): string | null {
  const identifier = linearIdentifierForSourceId(id);
  return identifier ? `https://linear.app/issue/${encodeURIComponent(identifier)}` : null;
}

// gmail:thread:<threadId> — the #all view finds a thread regardless of label.
function gmailHrefForSourceId(id: string): string | null {
  const parts = id.split(":");
  if (parts.length !== 2 || parts[0] !== "thread") return null;
  const threadId = parts[1] ?? "";
  if (!GMAIL_THREAD_PATTERN.test(threadId)) return null;
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

// slack:conversation:<teamId>:<channelId>:<windowEndTs> — deep-link to the
// channel; window timestamps do not map to a single anchorable message.
function slackHrefForSourceId(id: string): string | null {
  const parts = id.split(":");
  if (parts.length < 3 || parts[0] !== "conversation") return null;
  const teamId = parts[1] ?? "";
  const channelId = parts[2] ?? "";
  if (!SLACK_TEAM_PATTERN.test(teamId) || !SLACK_CHANNEL_PATTERN.test(channelId)) return null;
  return `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}`;
}

// google-drive:file:<fileId> — /open?id= redirects to the right editor per type.
function googleDriveHrefForSourceId(id: string): string | null {
  const parts = id.split(":");
  if (parts.length !== 2 || parts[0] !== "file") return null;
  const fileId = parts[1] ?? "";
  if (!DRIVE_FILE_PATTERN.test(fileId)) return null;
  return `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`;
}

// hubspot:<portalId>:<objectType>:<objectId> — canonical record URL by type id.
function hubspotHrefForSourceId(id: string): string | null {
  const parts = id.split(":");
  if (parts.length !== 3) return null;
  const [portalId, objectType, objectId] = parts;
  const objectTypeId = HUBSPOT_OBJECT_TYPE_IDS[objectType ?? ""];
  if (!objectTypeId) return null;
  if (!portalId || !HUBSPOT_NUMERIC_PATTERN.test(portalId)) return null;
  if (!objectId || !HUBSPOT_NUMERIC_PATTERN.test(objectId)) return null;
  return `https://app.hubspot.com/contacts/${portalId}/record/${objectTypeId}/${objectId}`;
}

// fathom:recording:<id>
function fathomHrefForSourceId(id: string): string | null {
  const parts = id.split(":");
  if (parts.length !== 2 || parts[0] !== "recording") return null;
  const recordingId = parts[1] ?? "";
  if (!FATHOM_RECORDING_PATTERN.test(recordingId)) return null;
  return `https://fathom.video/calls/${encodeURIComponent(recordingId)}`;
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
