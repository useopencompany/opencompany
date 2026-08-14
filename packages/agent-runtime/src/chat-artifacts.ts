export const PUBLISH_ARTIFACT_TOOL_NAME = "publish_artifact";
export const CHAT_ARTIFACT_DATA_PART_TYPE = "data-artifact-file" as const;
export const CHAT_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const CHAT_ARTIFACT_MAX_PER_TURN = 5;

export const PUBLISH_ARTIFACT_TOOL_DESCRIPTION =
  "Publish a finished file from the current sandbox into the chat as a durable user-visible file. Call this only for outputs the user should receive, not source files, repository diffs, logs, or temporary work.";

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
