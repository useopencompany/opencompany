export const PUBLISH_ARTIFACT_TOOL_NAME = "publish_artifact";
export const WRITE_ARTIFACT_TOOL_NAME = "write_artifact";
export const CHAT_ARTIFACT_DATA_PART_TYPE = "data-artifact-file" as const;
export const CHAT_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const CHAT_ARTIFACT_MAX_PER_TURN = 5;

export const PUBLISH_ARTIFACT_TOOL_DESCRIPTION =
  "Publish a finished file from the current sandbox into the chat as a durable user-visible file. Call this only for outputs the user should receive, not source files, repository diffs, logs, or temporary work.";

export const WRITE_ARTIFACT_TOOL_DESCRIPTION =
  "Create or revise an artifact in this chat. Use a Markdown document (.md) for finished reports, briefs, plans, and other substantial writing, and a self-contained HTML page (.html) when the result is visual or interactive, such as a dashboard, calculator, timeline, diagram, or mockup. Send the complete file content on every call. HTML runs in a locked-down sandbox: put all CSS and JavaScript inline, embed images as data: URIs, and keep state in memory, because network requests, external resources, cookies, storage APIs, forms, and navigation are all blocked. For a new artifact, omit artifact_id and expected_version. To revise an existing artifact, reuse artifact_id and pass the version currently shown as expected_version.";

export type WriteArtifactMediaType = "text/markdown" | "text/html";

const WRITE_ARTIFACT_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, WriteArtifactMediaType>> = {
  ".md": "text/markdown",
  ".html": "text/html",
};

/** Resolves the trusted media type for an in-band artifact filename, or null when unsupported. */
export function writeArtifactMediaType(filename: string): WriteArtifactMediaType | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 1) return null;
  return WRITE_ARTIFACT_MEDIA_TYPE_BY_EXTENSION[filename.slice(dot).toLowerCase()] ?? null;
}

// Agent-authored HTML is untrusted: a prompt-injected page must not be able to read app state or
// send anything anywhere. `sandbox` without `allow-same-origin` drops the document into an opaque
// origin with no cookies, storage, or access to the embedding page, and `default-src 'none'` blocks
// every fetch, XHR, WebSocket, and beacon, so the only permitted code and data are the bytes we
// stored. Everything the page needs must therefore be inline.
export const HTML_ARTIFACT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

export const PUBLISH_ARTIFACT_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description: "Absolute path, or path relative to the current chat working directory.",
    },
    title: {
      type: "string",
      description: "Short user-facing title. Defaults to the filename.",
    },
    description: {
      type: "string",
      description: "Optional one-sentence description of the file.",
    },
    artifact_id: {
      type: "string",
      description: "Stable artifact id when publishing a new version of an earlier file.",
    },
    expected_version: {
      type: "integer",
      description:
        "Required with artifact_id. The version currently shown in chat; prevents overwriting a newer publication.",
    },
  },
  required: ["path"],
} as const;

export const WRITE_ARTIFACT_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    filename: {
      type: "string",
      description:
        "A user-friendly filename without directory paths, ending in .md for a Markdown document or .html for a self-contained interactive page.",
    },
    title: {
      type: "string",
      description: "Short user-facing title for the artifact.",
    },
    description: {
      type: "string",
      description: "Optional one-sentence description of the artifact.",
    },
    content: {
      type: "string",
      description:
        "The complete file content for this version: Markdown for a .md filename, a full HTML document for a .html filename.",
    },
    artifact_id: {
      type: "string",
      description:
        "For revisions only: the stable artifact id of an earlier artifact. Omit when creating a new artifact.",
    },
    expected_version: {
      type: "integer",
      minimum: 1,
      description:
        "For revisions only: the current version number. Required with artifact_id and omitted for a new artifact.",
    },
  },
  required: ["filename", "title", "content"],
} as const;

export type WriteArtifactToolInput = {
  filename: string;
  title: string;
  description?: string;
  content: string;
  artifact_id?: string;
  expected_version?: number;
};

export type PublishedChatArtifact = {
  artifactId: string;
  artifactVersionId: string;
  version: number;
  title: string;
  description?: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  state: "ready" | "deleted";
};

export type PublishArtifactToolResponse =
  | { ok: true; artifact: PublishedChatArtifact }
  | { ok: false; error: string };

export type WriteArtifactToolResponse = PublishArtifactToolResponse;

export function parsePublishedChatArtifact(value: unknown): PublishedChatArtifact | null {
  const response = readRecord(value);
  const artifact = readRecord(response?.artifact);
  if (response?.ok !== true || !artifact) return null;
  if (
    !nonEmptyString(artifact.artifactId) ||
    !nonEmptyString(artifact.artifactVersionId) ||
    !positiveInteger(artifact.version) ||
    !nonEmptyString(artifact.title) ||
    !nonEmptyString(artifact.filename) ||
    !nonEmptyString(artifact.mediaType) ||
    !nonNegativeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes > CHAT_ARTIFACT_MAX_BYTES ||
    (artifact.state !== "ready" && artifact.state !== "deleted")
  ) {
    return null;
  }
  return {
    artifactId: artifact.artifactId,
    artifactVersionId: artifact.artifactVersionId,
    version: artifact.version,
    title: artifact.title,
    ...(nonEmptyString(artifact.description) ? { description: artifact.description } : {}),
    filename: artifact.filename,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    state: artifact.state,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
