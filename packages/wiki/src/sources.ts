// The canonical registry of wiki source pointers: `[[source:provider:id]]`.
//
// A source ref is how a wiki page points at an artifact that lives in another
// tool — a Linear issue, a Gmail thread, a Granola note. The page keeps the
// claim; the other tool stays the canonical home of the content. The grammar is
// `provider:id` (validated in ./schema); this module is the one place that says
// what `id` looks like per provider, how the ref renders, and where it opens.
//
// Everything that touches a provider's ref grammar reads it from here: the wiki
// tool description agents are prompted with, the chips the editor renders, and
// `docs/wiki/source-refs.md`. A provider defined in one place and resolved in
// another is how refs end up shaped right but rendered dead.

import { parseWikiSourceRef } from "./schema";

export type WikiSourceIcon = "link" | "github";

export type WikiSourceDescription = {
  /** Human label for a chip when the author wrote no label of their own. */
  label: string;
  /** Canonical URL, or null when the provider has no stable per-artifact URL. */
  href: string | null;
  icon: WikiSourceIcon;
};

export type WikiSourceProvider = {
  provider: string;
  /** Ref shape shown to agents and in the docs, e.g. `linear:issue:<IDENTIFIER>`. */
  refShape: string;
  /**
   * Describes a ref's id, or null when the id does not match this provider's
   * grammar. Returning null is deliberate: a malformed ref renders as an inert
   * chip rather than a link to an attacker-shaped URL.
   */
  describe(id: string): WikiSourceDescription | null;
};

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const NUMERIC_PATTERN = /^\d+$/;
const LINEAR_IDENTIFIER_PATTERN = /^[A-Za-z0-9]+-\d+$/;
const GMAIL_THREAD_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const SLACK_TEAM_PATTERN = /^[TE][A-Z0-9]{6,20}$/;
const SLACK_CHANNEL_PATTERN = /^[CDG][A-Z0-9]{6,20}$/;
const DRIVE_FILE_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;
const HUBSPOT_NUMERIC_PATTERN = /^\d{1,20}$/;
const FATHOM_RECORDING_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const GRANOLA_NOTE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ATTIO_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
// Jamie ids are whatever the calendar provider hands over (including iCalUIDs
// with `@` and `:`), so the label path stays permissive; nothing builds a URL.
const JAMIE_EVENT_PATTERN = /^[A-Za-z0-9_.@:-]{1,128}$/;

// Object-type lookups are Maps, not object literals: the key comes straight out
// of a page body, and a plain literal answers `__proto__` and `constructor` with
// an inherited truthy value that then sails past the "unknown type" guard.
const HUBSPOT_OBJECTS = new Map<string, { typeId: string; label: string }>([
  ["contact", { typeId: "0-1", label: "HubSpot contact" }],
  ["company", { typeId: "0-2", label: "HubSpot company" }],
  ["deal", { typeId: "0-3", label: "HubSpot deal" }],
]);

const ATTIO_OBJECT_LABELS = new Map<string, string>([
  ["person", "Attio person"],
  ["company", "Attio company"],
  ["deal", "Attio deal"],
]);

export const WIKI_SOURCE_PROVIDERS: readonly WikiSourceProvider[] = [
  {
    provider: "linear",
    refShape: "linear:issue:<IDENTIFIER>",
    describe(id) {
      const identifier = segment(id, "issue");
      if (!identifier || !LINEAR_IDENTIFIER_PATTERN.test(identifier)) return null;
      const upper = identifier.toUpperCase();
      return {
        label: upper,
        href: `https://linear.app/issue/${encodeURIComponent(upper)}`,
        icon: "link",
      };
    },
  },
  {
    provider: "github",
    refShape: "github:<owner>/<repo>[:pull|issue:<number>[:comment:<id>]]",
    describe: describeGitHub,
  },
  {
    provider: "gmail",
    refShape: "gmail:thread:<threadId>",
    describe(id) {
      const threadId = segment(id, "thread");
      if (!threadId || !GMAIL_THREAD_PATTERN.test(threadId)) return null;
      // The #all view finds a thread regardless of which labels it carries.
      return {
        label: "Gmail thread",
        href: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`,
        icon: "link",
      };
    },
  },
  {
    provider: "slack",
    refShape: "slack:conversation:<teamId>:<channelId>:<windowEndTs>",
    describe(id) {
      const parts = id.split(":");
      if (parts.length < 3 || parts[0] !== "conversation") return null;
      const teamId = parts[1] ?? "";
      const channelId = parts[2] ?? "";
      if (!SLACK_TEAM_PATTERN.test(teamId) || !SLACK_CHANNEL_PATTERN.test(channelId)) return null;
      // Window timestamps do not map to a single anchorable message, so the
      // deep link lands on the channel.
      return {
        label: "Slack conversation",
        href: `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}`,
        icon: "link",
      };
    },
  },
  {
    provider: "google-drive",
    refShape: "google-drive:file:<fileId>",
    describe(id) {
      const fileId = segment(id, "file");
      if (!fileId || !DRIVE_FILE_PATTERN.test(fileId)) return null;
      // /open?id= redirects to the right editor for the file's type.
      return {
        label: "Google Drive file",
        href: `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`,
        icon: "link",
      };
    },
  },
  {
    provider: "hubspot",
    refShape: "hubspot:<portalId>:<contact|company|deal>:<objectId>",
    describe(id) {
      const parts = id.split(":");
      if (parts.length !== 3) return null;
      const [portalId, objectType, objectId] = parts;
      const object = HUBSPOT_OBJECTS.get(objectType ?? "");
      if (!object) return null;
      if (!portalId || !HUBSPOT_NUMERIC_PATTERN.test(portalId)) return null;
      if (!objectId || !HUBSPOT_NUMERIC_PATTERN.test(objectId)) return null;
      return {
        label: object.label,
        href: `https://app.hubspot.com/contacts/${portalId}/record/${object.typeId}/${objectId}`,
        icon: "link",
      };
    },
  },
  {
    provider: "attio",
    refShape: "attio:<workspaceId>:<object>:<recordId>",
    describe(id) {
      const parts = id.split(":");
      if (parts.length !== 3) return null;
      const [workspaceId, objectType, recordId] = parts;
      if (!workspaceId || !ATTIO_ID_PATTERN.test(workspaceId)) return null;
      if (!objectType || !recordId || !ATTIO_ID_PATTERN.test(recordId)) return null;
      // Attio's app URLs are keyed by workspace *slug*, which the ref does not
      // carry, so this stays a pointer with no link rather than a guess.
      return {
        label: ATTIO_OBJECT_LABELS.get(objectType) ?? "Attio record",
        href: null,
        icon: "link",
      };
    },
  },
  {
    provider: "granola",
    refShape: "granola:note:<noteId>",
    describe(id) {
      const noteId = segment(id, "note");
      if (!noteId || !GRANOLA_NOTE_PATTERN.test(noteId)) return null;
      return {
        label: "Granola note",
        href: `https://app.granola.ai/notes/${encodeURIComponent(noteId)}`,
        icon: "link",
      };
    },
  },
  {
    provider: "fathom",
    refShape: "fathom:recording:<recordingId>",
    describe(id) {
      const recordingId = segment(id, "recording");
      if (!recordingId || !FATHOM_RECORDING_PATTERN.test(recordingId)) return null;
      return {
        label: "Fathom recording",
        href: `https://fathom.video/calls/${encodeURIComponent(recordingId)}`,
        icon: "link",
      };
    },
  },
  {
    provider: "jamie",
    refShape: "jamie:meeting:<eventId>",
    describe(id) {
      const eventId = after(id, "meeting");
      if (!eventId || !JAMIE_EVENT_PATTERN.test(eventId)) return null;
      // Jamie exposes no per-meeting web URL; the ref is provenance only.
      return { label: "Jamie meeting", href: null, icon: "link" };
    },
  },
  {
    provider: "web",
    refShape: "web:<https url>",
    describe(id) {
      const url = safeExternalUrl(id);
      return url ? { label: hostnameOf(url) ?? "Web page", href: url, icon: "link" } : null;
    },
  },
];

const PROVIDERS_BY_NAME = new Map(
  WIKI_SOURCE_PROVIDERS.map((provider) => [provider.provider, provider]),
);

/**
 * Describes a whole `provider:id` ref. Returns null for an unknown provider or
 * an id that does not fit that provider's grammar — callers render those as
 * inert chips carrying the raw ref, which is the honest state: the pointer was
 * recorded but nothing here knows how to open it.
 */
export function describeWikiSourceRef(ref: string): WikiSourceDescription | null {
  const parsed = parseWikiSourceRef(ref);
  if (!parsed) return null;

  // Any provider may carry a full URL as its id (e.g. `notion:https://...`),
  // which beats the per-provider grammar because it is already canonical.
  const directUrl = safeExternalUrl(parsed.id);
  const known = PROVIDERS_BY_NAME.get(parsed.provider);
  if (directUrl && known?.provider !== "web") {
    return { label: hostnameOf(directUrl) ?? parsed.provider, href: directUrl, icon: "link" };
  }
  return known?.describe(parsed.id) ?? null;
}

export function wikiSourceHref(ref: string): string | null {
  return describeWikiSourceRef(ref)?.href ?? null;
}

export function isKnownWikiSourceProvider(provider: string): boolean {
  return PROVIDERS_BY_NAME.has(provider);
}

/**
 * One-line catalogue of the ref shapes, embedded in the wiki tool description
 * so writing agents cite the grammar that actually resolves instead of
 * inventing a plausible-looking one.
 */
export const WIKI_SOURCE_REF_GUIDE = WIKI_SOURCE_PROVIDERS.map(
  (provider) => provider.refShape,
).join(", ");

function describeGitHub(id: string): WikiSourceDescription | null {
  const parts = id.split(":");
  const repository = parseGitHubRepository(parts[0] ?? "");
  if (!repository) return null;

  const repositoryHref = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const repositoryName = `${repository.owner}/${repository.repo}`;
  if (parts.length === 1) {
    return { label: repositoryName, href: repositoryHref, icon: "github" };
  }
  if (parts.length !== 3 && parts.length !== 5) return null;

  const [, kind, number, commentToken, commentId] = parts;
  if (kind !== "pull" && kind !== "issue") return null;
  if (!number || !NUMERIC_PATTERN.test(number)) return null;
  if (parts.length === 5 && (commentToken !== "comment" || !commentId)) return null;
  if (commentId && !NUMERIC_PATTERN.test(commentId)) return null;

  const pathKind = kind === "pull" ? "pull" : "issues";
  const hash = commentId ? `#issuecomment-${commentId}` : "";
  return {
    label: `#${number}`,
    href: `${repositoryHref}/${pathKind}/${number}${hash}`,
    icon: "github",
  };
}

function parseGitHubRepository(value: string): { owner: string; repo: string } | null {
  const [owner, repo, ...extra] = value.split("/");
  if (!owner || !repo || extra.length > 0) return null;
  if (!GITHUB_OWNER_PATTERN.test(owner)) return null;
  if (!GITHUB_REPO_PATTERN.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** The single id after a fixed `kind:` prefix, e.g. `issue:ENG-1` -> `ENG-1`. */
function segment(id: string, kind: string): string | null {
  const parts = id.split(":");
  if (parts.length !== 2 || parts[0] !== kind) return null;
  return parts[1] ?? null;
}

/** Everything after a fixed `kind:` prefix, for ids that may contain colons. */
function after(id: string, kind: string): string | null {
  const prefix = `${kind}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) || null : null;
}

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
