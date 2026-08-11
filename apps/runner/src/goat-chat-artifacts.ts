import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  GOAT_CHAT_ARTIFACT_MAX_BYTES,
  GOAT_CHAT_ARTIFACT_MAX_PER_TURN,
  GOAT_PUBLISH_ARTIFACT_INPUT_JSON_SCHEMA,
  GOAT_PUBLISH_ARTIFACT_TOOL_DESCRIPTION,
  GOAT_PUBLISH_ARTIFACT_TOOL_NAME,
  type GoatPublishArtifactToolResponse,
  type GoatPublishedChatArtifact,
  shellQuote,
} from "@opencompany/agent-runtime";
import {
  type GoatCodexChatEngine,
  goatChatArtifacts,
  goatChatArtifactVersions,
  goatCodexChatSessions,
  goatCodexChatTurns,
  goatWorkspaceMembers,
} from "@opencompany/db/goat-schema";
import { authorizePersistedGoatClaudeToolCapability } from "@opencompany/goat-agent/application/persisted-claude-capability";
import { createLogger } from "@opencompany/observability";
import { del, put } from "@vercel/blob";
import { and, eq, sql } from "drizzle-orm";
import type {
  CodexAppServerDynamicTool,
  CodexAppServerDynamicToolCall,
  CodexAppServerDynamicToolResponse,
} from "./codex-app-server";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { connectSandbox, type SandboxHandle } from "./sandbox";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-chat-artifacts" });

const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".srt": "application/x-subrip",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

type PublishArtifactContext = {
  sandbox: SandboxHandle;
  workDirectory: string;
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  codexChatSessionId: string;
  turnId: string;
  assistantMessageId: string;
  engine: Exclude<GoatCodexChatEngine, "opencompany">;
  env: Pick<RunnerEnv, "blobReadWriteToken">;
  checkAbort: () => Promise<void>;
};

type PublishArtifactInput = {
  path: string;
  title?: string;
  description?: string;
  artifactId?: string;
  expectedVersion?: number;
};

export function createGoatPublishArtifactDynamicTool(
  context: PublishArtifactContext,
): CodexAppServerDynamicTool {
  return {
    spec: {
      type: "function",
      name: GOAT_PUBLISH_ARTIFACT_TOOL_NAME,
      description: GOAT_PUBLISH_ARTIFACT_TOOL_DESCRIPTION,
      inputSchema: GOAT_PUBLISH_ARTIFACT_INPUT_JSON_SCHEMA,
    },
    execute: (call) => executeGoatPublishArtifactDynamicTool({ context, call }),
  };
}

export async function executeGoatPublishArtifactDynamicTool(input: {
  context: PublishArtifactContext;
  call: CodexAppServerDynamicToolCall;
}): Promise<CodexAppServerDynamicToolResponse> {
  let response: GoatPublishArtifactToolResponse;
  try {
    response = await publishGoatChatArtifact({
      context: input.context,
      input: normalizePublishArtifactInput(input.call.arguments),
      toolCallId: input.call.callId,
    });
  } catch (error) {
    logger.warn("Failed to publish a generated chat file", {
      event: "opencompany.goat_chat_artifact_publish_failed",
      chat_session_id: input.context.chatSessionId,
      codex_chat_turn_id: input.context.turnId,
      engine: input.context.engine,
      error: error instanceof Error ? error.message : "The file could not be published.",
    });
    response = {
      ok: false,
      error: error instanceof Error ? error.message : "The file could not be published.",
    };
  }
  return {
    success: response.ok,
    contentItems: [{ type: "inputText", text: JSON.stringify(response) }],
  };
}

export async function publishGoatChatArtifact(input: {
  context: PublishArtifactContext;
  input: PublishArtifactInput;
  toolCallId: string;
}): Promise<GoatPublishArtifactToolResponse> {
  await input.context.checkAbort();
  if (!input.toolCallId.trim() || input.toolCallId.length > 500) {
    throw new Error("The host supplied an invalid tool call id.");
  }
  const db = getDb();
  const priorPublication = await loadToolCallPublication({
    turnId: input.context.turnId,
    toolCallId: input.toolCallId,
  });
  if (priorPublication) return { ok: true, artifact: priorPublication };
  const publicationCount = await countTurnPublications(db, input.context.turnId);
  if (publicationCount >= GOAT_CHAT_ARTIFACT_MAX_PER_TURN) {
    throw new Error(
      `This turn already published ${GOAT_CHAT_ARTIFACT_MAX_PER_TURN} files, which is the limit.`,
    );
  }

  const existing = input.input.artifactId
    ? await loadExistingArtifact({
        artifactId: input.input.artifactId,
        workspaceId: input.context.workspaceId,
        userWorkosId: input.context.userWorkosId,
        chatSessionId: input.context.chatSessionId,
      })
    : null;
  if (input.input.artifactId && !existing) {
    throw new Error("That file is not available in this chat.");
  }
  if (existing && input.input.expectedVersion !== existing.currentVersion) {
    throw new Error(
      `This file is currently at version ${existing.currentVersion}. Retry with expected_version ${existing.currentVersion}.`,
    );
  }
  if (!existing && input.input.expectedVersion !== undefined) {
    throw new Error("expected_version can only be used together with artifact_id.");
  }
  if (existing && input.input.expectedVersion === undefined) {
    throw new Error("expected_version is required when publishing a new version.");
  }

  const file = await loadPublishableSandboxFile({
    sandbox: input.context.sandbox,
    workDirectory: input.context.workDirectory,
    requestedPath: input.input.path,
  });
  await input.context.checkAbort();

  const artifactId = existing?.id ?? `goat_chat_artifact_${randomUUID()}`;
  const artifactVersionId = `goat_chat_artifact_version_${randomUUID()}`;
  const version = (existing?.currentVersion ?? 0) + 1;
  const title = boundedText(input.input.title, 160) ?? existing?.title ?? file.filename;
  const description =
    input.input.description === undefined
      ? (existing?.description ?? undefined)
      : boundedText(input.input.description, 500);
  const contentSha256 = createHash("sha256").update(file.bytes).digest("hex");
  const blobPath = artifactBlobPath({
    workspaceId: input.context.workspaceId,
    artifactId,
    artifactVersionId,
    filename: file.filename,
  });
  const stored = await put(blobPath, file.bytes, {
    access: "private",
    addRandomSuffix: false,
    contentType: file.mediaType,
    ...(input.context.env.blobReadWriteToken
      ? { token: input.context.env.blobReadWriteToken }
      : {}),
  });

  try {
    const persisted = existing
      ? await persistArtifactVersion({
          artifactId,
          artifactVersionId,
          toolCallId: input.toolCallId,
          expectedVersion: existing.currentVersion,
          version,
          title,
          description,
          filename: file.filename,
          mediaType: file.mediaType,
          sizeBytes: file.bytes.byteLength,
          contentSha256,
          blobPathname: stored.pathname,
          context: input.context,
        })
      : await persistNewArtifact({
          artifactId,
          artifactVersionId,
          toolCallId: input.toolCallId,
          version,
          title,
          description,
          filename: file.filename,
          mediaType: file.mediaType,
          sizeBytes: file.bytes.byteLength,
          contentSha256,
          blobPathname: stored.pathname,
          context: input.context,
        });
    if (!persisted) {
      throw new Error(
        existing
          ? "A newer version was published first. Retry using the latest expected_version."
          : "The file publication could not be recorded.",
      );
    }
  } catch (error) {
    await del(stored.pathname, {
      ...(input.context.env.blobReadWriteToken
        ? { token: input.context.env.blobReadWriteToken }
        : {}),
    }).catch(() => undefined);
    throw error;
  }

  const artifact: GoatPublishedChatArtifact = {
    artifactId,
    artifactVersionId,
    version,
    title,
    ...(description ? { description } : {}),
    filename: file.filename,
    mediaType: file.mediaType,
    sizeBytes: file.bytes.byteLength,
    state: "ready",
  };
  logger.info("Published a generated chat file", {
    event: "opencompany.goat_chat_artifact_published",
    artifact_id: artifactId,
    artifact_version_id: artifactVersionId,
    version,
    media_type: file.mediaType,
    size_bytes: file.bytes.byteLength,
    chat_session_id: input.context.chatSessionId,
    codex_chat_turn_id: input.context.turnId,
    engine: input.context.engine,
  });
  return { ok: true, artifact };
}

export async function publishGoatClaudeChatArtifact(input: {
  codexChatSessionId: string;
  codexChatTurnId: string;
  toolCallId: string;
  arguments: unknown;
  attemptId?: string;
  leaseId?: string;
  env: RunnerEnv;
  signal?: AbortSignal;
}): Promise<GoatPublishArtifactToolResponse> {
  if (Boolean(input.attemptId) !== Boolean(input.leaseId)) {
    return { ok: false, error: "The Claude Code capability is incomplete." };
  }
  if (
    input.attemptId &&
    input.leaseId &&
    !(await authorizePersistedGoatClaudeToolCapability({
      capability: {
        codexChatSessionId: input.codexChatSessionId,
        codexChatTurnId: input.codexChatTurnId,
        attemptId: input.attemptId,
        leaseId: input.leaseId,
      },
    }))
  ) {
    return { ok: false, error: "This Claude Code turn is no longer active." };
  }
  const [row] = await getDb()
    .select({
      session: goatCodexChatSessions,
      turn: goatCodexChatTurns,
    })
    .from(goatCodexChatTurns)
    .innerJoin(
      goatCodexChatSessions,
      eq(goatCodexChatTurns.codexChatSessionId, goatCodexChatSessions.id),
    )
    .innerJoin(
      goatWorkspaceMembers,
      and(
        eq(goatWorkspaceMembers.workspaceId, goatCodexChatSessions.workspaceId),
        eq(goatWorkspaceMembers.userWorkosId, goatCodexChatSessions.userWorkosId),
      ),
    )
    .where(
      and(
        eq(goatCodexChatTurns.id, input.codexChatTurnId),
        eq(goatCodexChatTurns.codexChatSessionId, input.codexChatSessionId),
        ...(input.leaseId ? [eq(goatCodexChatTurns.leaseId, input.leaseId)] : []),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.session.engine !== "claude_code" ||
    row.session.status !== "running" ||
    row.session.activeTurnId !== row.turn.id ||
    row.turn.status !== "running" ||
    !row.session.workspaceId ||
    !row.session.sandboxId ||
    !row.turn.leaseId ||
    !row.turn.leaseOwner
  ) {
    return { ok: false, error: "This Claude Code turn is no longer active." };
  }
  const checkAbort = async () => {
    if (input.signal?.aborted) throw new Error("The file publication was canceled.");
    const [active] = await getDb()
      .select({
        status: goatCodexChatTurns.status,
        interruptAt: goatCodexChatTurns.interruptRequestedAt,
      })
      .from(goatCodexChatTurns)
      .where(
        and(
          eq(goatCodexChatTurns.id, row.turn.id),
          eq(goatCodexChatTurns.leaseId, row.turn.leaseId as string),
          eq(goatCodexChatTurns.leaseOwner, row.turn.leaseOwner as string),
        ),
      )
      .limit(1);
    if (!active || active.status !== "running" || active.interruptAt) {
      throw new Error("This Claude Code turn is no longer active.");
    }
  };
  try {
    await checkAbort();
    const sandbox = await connectSandbox({ sandboxId: row.session.sandboxId });
    if (!sandbox) return { ok: false, error: "The Claude Code sandbox is no longer available." };
    return await publishGoatChatArtifact({
      context: {
        sandbox,
        workDirectory: "/home/user/opencompany-goat/claude-chat",
        workspaceId: row.session.workspaceId,
        userWorkosId: row.turn.userWorkosId,
        chatSessionId: row.turn.chatSessionId,
        codexChatSessionId: row.session.id,
        turnId: row.turn.id,
        assistantMessageId: row.turn.assistantMessageId,
        engine: "claude_code",
        env: input.env,
        checkAbort,
      },
      input: normalizePublishArtifactInput(input.arguments),
      toolCallId: input.toolCallId,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The file could not be published.",
    };
  }
}

function normalizePublishArtifactInput(value: unknown): PublishArtifactInput {
  if (!isRecord(value)) throw new Error("publish_artifact expects an object input.");
  const requestedPath = boundedText(value.path, 4_096);
  if (!requestedPath) throw new Error("path is required.");
  const artifactId = boundedText(value.artifact_id, 200);
  const expectedVersion = value.expected_version;
  if (
    expectedVersion !== undefined &&
    (typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1)
  ) {
    throw new Error("expected_version must be a positive integer.");
  }
  return {
    path: requestedPath,
    ...(value.title !== undefined
      ? { title: requiredBoundedString(value.title, "title", 160) }
      : {}),
    ...(value.description !== undefined
      ? { description: requiredBoundedString(value.description, "description", 500) }
      : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(typeof expectedVersion === "number" ? { expectedVersion } : {}),
  };
}

async function loadPublishableSandboxFile(input: {
  sandbox: SandboxHandle;
  workDirectory: string;
  requestedPath: string;
}) {
  const requestedPath = path.posix.resolve(input.workDirectory, input.requestedPath);
  if (!isPathWithinDirectory(requestedPath, input.workDirectory)) {
    throw new Error("The file must be inside the current chat working directory.");
  }
  const realPathResult = await input.sandbox.commands.run(
    `realpath -- ${shellQuote(requestedPath)}`,
    { timeoutMs: 30_000 },
  );
  const realPath = String(realPathResult.stdout ?? "").trim();
  if (
    realPathResult.exitCode !== 0 ||
    !realPath ||
    !isPathWithinDirectory(realPath, input.workDirectory)
  ) {
    throw new Error("The file does not exist inside the current chat working directory.");
  }
  const info = await input.sandbox.files.getInfo(realPath);
  if (info.type !== "file") throw new Error("Only regular files can be published.");
  if (info.size > GOAT_CHAT_ARTIFACT_MAX_BYTES) {
    throw new Error("The file is larger than the 20 MB publication limit.");
  }
  const filename = path.posix.basename(realPath).slice(0, 255);
  const mediaType = MEDIA_TYPE_BY_EXTENSION[path.posix.extname(filename).toLowerCase()];
  if (!mediaType) {
    throw new Error(
      "That file type is not supported. Publish Markdown, text, CSV, TSV, JSON, SRT, PDF, DOCX, XLSX, PPTX, PNG, JPEG, or WebP.",
    );
  }
  const bytes = Buffer.from(await input.sandbox.files.read(realPath, { format: "bytes" }));
  if (bytes.byteLength !== info.size) throw new Error("The file changed while it was being read.");
  if (!hasExpectedFileSignature(path.posix.extname(filename).toLowerCase(), bytes)) {
    throw new Error("The file contents do not match its filename extension.");
  }
  return { bytes, filename, mediaType };
}

function hasExpectedFileSignature(extension: string, bytes: Buffer) {
  if (extension === ".pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (extension === ".png") {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (extension === ".webp") {
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (extension === ".docx" || extension === ".xlsx" || extension === ".pptx") {
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }
  return true;
}

async function loadExistingArtifact(input: {
  artifactId: string;
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
}) {
  const [artifact] = await getDb()
    .select()
    .from(goatChatArtifacts)
    .where(
      and(
        eq(goatChatArtifacts.id, input.artifactId),
        eq(goatChatArtifacts.workspaceId, input.workspaceId),
        eq(goatChatArtifacts.userWorkosId, input.userWorkosId),
        eq(goatChatArtifacts.chatSessionId, input.chatSessionId),
        sql`${goatChatArtifacts.archivedAt} IS NULL`,
      ),
    )
    .limit(1);
  return artifact ?? null;
}

async function loadToolCallPublication(input: { turnId: string; toolCallId: string }) {
  const [row] = await getDb()
    .select({ artifact: goatChatArtifacts, version: goatChatArtifactVersions })
    .from(goatChatArtifactVersions)
    .innerJoin(goatChatArtifacts, eq(goatChatArtifactVersions.artifactId, goatChatArtifacts.id))
    .where(
      and(
        eq(goatChatArtifactVersions.sourceTurnId, input.turnId),
        eq(goatChatArtifactVersions.sourceToolCallId, input.toolCallId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    artifactId: row.artifact.id,
    artifactVersionId: row.version.id,
    version: row.version.version,
    title: row.version.title,
    ...(row.version.description ? { description: row.version.description } : {}),
    filename: row.version.filename,
    mediaType: row.version.mediaType,
    sizeBytes: row.version.sizeBytes,
    state: row.artifact.archivedAt ? ("deleted" as const) : ("ready" as const),
  };
}

async function countTurnPublications(db: ReturnType<typeof getDb>, turnId: string) {
  const result = await db.execute(sql`
    SELECT count(*)::int AS count
    FROM goat.chat_artifact_versions
    WHERE source_turn_id = ${turnId}
  `);
  return rowsFromExecute<{ count: number }>(result)[0]?.count ?? 0;
}

type PersistArtifactInput = {
  artifactId: string;
  artifactVersionId: string;
  toolCallId: string;
  version: number;
  title: string;
  description: string | undefined;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  contentSha256: string;
  blobPathname: string;
  context: PublishArtifactContext;
};

async function persistNewArtifact(input: PersistArtifactInput) {
  const result = await getDb().execute(sql`
    WITH inserted_artifact AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.context.turnId}, 0))
    ), publication_slot AS (
      SELECT 1
      FROM inserted_artifact
      WHERE (
        SELECT count(*)
        FROM goat.chat_artifact_versions
        WHERE source_turn_id = ${input.context.turnId}
      ) < ${GOAT_CHAT_ARTIFACT_MAX_PER_TURN}
    ), created_artifact AS (
      INSERT INTO goat.chat_artifacts (
        id, workspace_id, user_workos_id, chat_session_id, title, description,
        current_version, created_at, updated_at
      ) SELECT
        ${input.artifactId}, ${input.context.workspaceId}, ${input.context.userWorkosId},
        ${input.context.chatSessionId}, ${input.title}, ${input.description ?? null},
        ${input.version}, now(), now()
      FROM publication_slot
      ON CONFLICT DO NOTHING
      RETURNING id
    ), inserted_version AS (
      INSERT INTO goat.chat_artifact_versions (
        id, artifact_id, version, title, description, filename, media_type, size_bytes, content_sha256,
        blob_pathname, source_engine, source_tool_call_id, source_turn_id, source_message_id,
        created_at
      )
      SELECT
        ${input.artifactVersionId}, created_artifact.id, ${input.version}, ${input.title},
        ${input.description ?? null}, ${input.filename}, ${input.mediaType}, ${input.sizeBytes},
        ${input.contentSha256}, ${input.blobPathname},
        ${input.context.engine}, ${input.toolCallId}, ${input.context.turnId},
        ${input.context.assistantMessageId}, now()
      FROM created_artifact
      RETURNING id
    )
    SELECT id FROM inserted_version
  `);
  return rowsFromExecute<{ id: string }>(result)[0]?.id ?? null;
}

async function persistArtifactVersion(input: PersistArtifactInput & { expectedVersion: number }) {
  const result = await getDb().execute(sql`
    WITH advanced_artifact AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.context.turnId}, 0))
    ), publication_slot AS (
      SELECT 1
      FROM advanced_artifact
      WHERE (
        SELECT count(*)
        FROM goat.chat_artifact_versions
        WHERE source_turn_id = ${input.context.turnId}
      ) < ${GOAT_CHAT_ARTIFACT_MAX_PER_TURN}
    ), updated_artifact AS (
      UPDATE goat.chat_artifacts
      SET current_version = ${input.version}, title = ${input.title},
          description = ${input.description ?? null}, updated_at = now()
      WHERE id = ${input.artifactId}
        AND workspace_id = ${input.context.workspaceId}
        AND user_workos_id = ${input.context.userWorkosId}
        AND chat_session_id = ${input.context.chatSessionId}
        AND current_version = ${input.expectedVersion}
        AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM publication_slot)
      RETURNING id
    ), inserted_version AS (
      INSERT INTO goat.chat_artifact_versions (
        id, artifact_id, version, title, description, filename, media_type, size_bytes, content_sha256,
        blob_pathname, source_engine, source_tool_call_id, source_turn_id, source_message_id,
        created_at
      )
      SELECT
        ${input.artifactVersionId}, updated_artifact.id, ${input.version}, ${input.title},
        ${input.description ?? null}, ${input.filename}, ${input.mediaType}, ${input.sizeBytes},
        ${input.contentSha256}, ${input.blobPathname},
        ${input.context.engine}, ${input.toolCallId}, ${input.context.turnId},
        ${input.context.assistantMessageId}, now()
      FROM updated_artifact
      RETURNING id
    )
    SELECT id FROM inserted_version
  `);
  return rowsFromExecute<{ id: string }>(result)[0]?.id ?? null;
}

function artifactBlobPath(input: {
  workspaceId: string;
  artifactId: string;
  artifactVersionId: string;
  filename: string;
}) {
  const filename = input.filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-160) || "file";
  return [
    "goat-chat-artifacts",
    encodeURIComponent(input.workspaceId),
    encodeURIComponent(input.artifactId),
    `${encodeURIComponent(input.artifactVersionId)}-${filename}`,
  ].join("/");
}

function isPathWithinDirectory(pathname: string, directory: string) {
  return pathname === directory || pathname.startsWith(`${directory}/`);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function requiredBoundedString(value: unknown, field: string, maxLength: number) {
  const result = boundedText(value, maxLength);
  if (!result) throw new Error(`${field} must be a non-empty string.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
