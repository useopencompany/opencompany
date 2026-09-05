import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { authorizePersistedExternalEngineToolCapability } from "@opencompany/agent/application/persisted-external-engine-capability";
import {
  CHAT_ARTIFACT_MAX_BYTES,
  CHAT_ARTIFACT_MAX_PER_TURN,
  CLOUD_CODING_ENGINE_CONFIG,
  PUBLISH_ARTIFACT_INPUT_JSON_SCHEMA,
  PUBLISH_ARTIFACT_TOOL_DESCRIPTION,
  PUBLISH_ARTIFACT_TOOL_NAME,
  type PublishArtifactToolResponse,
  type PublishedChatArtifact,
  shellQuote,
  type WriteArtifactToolInput,
} from "@opencompany/agent-runtime";
import {
  type CodexChatEngine,
  chatArtifacts,
  chatArtifactVersions,
  codexChatSessions,
  codexChatTurns,
  workspaceMembers,
} from "@opencompany/db/product-schema";
import { createLogger } from "@opencompany/observability";
import { del, put } from "@vercel/blob";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import type {
  ExternalEngineTool,
  ExternalEngineToolCall,
  ExternalEngineToolResponse,
} from "./external-engine-contract";
import { connectSandbox, type SandboxHandle } from "./sandbox";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-chat-artifacts",
});

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

type ArtifactPersistenceContext = {
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  codexChatSessionId: string;
  turnId: string;
  assistantMessageId: string;
  engine: CodexChatEngine;
  env: Pick<RunnerEnv, "blobReadWriteToken">;
  checkAbort: () => Promise<void>;
};

type PublishArtifactContext = ArtifactPersistenceContext & {
  sandbox: SandboxHandle;
  workDirectory: string;
  engine: Exclude<CodexChatEngine, "opencompany">;
};

type PublishArtifactInput = {
  path: string;
  title?: string;
  description?: string;
  artifactId?: string;
  expectedVersion?: number;
};

export function createPublishArtifactDynamicTool(
  context: PublishArtifactContext,
): ExternalEngineTool {
  return {
    spec: {
      type: "function",
      name: PUBLISH_ARTIFACT_TOOL_NAME,
      description: PUBLISH_ARTIFACT_TOOL_DESCRIPTION,
      inputSchema: PUBLISH_ARTIFACT_INPUT_JSON_SCHEMA,
    },
    execute: (call) => executePublishArtifactDynamicTool({ context, call }),
  };
}

export async function executePublishArtifactDynamicTool(input: {
  context: PublishArtifactContext;
  call: ExternalEngineToolCall;
}): Promise<ExternalEngineToolResponse> {
  let response: PublishArtifactToolResponse;
  try {
    response = await publishChatArtifact({
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

export async function publishChatArtifact(input: {
  context: PublishArtifactContext;
  input: PublishArtifactInput;
  toolCallId: string;
}): Promise<PublishArtifactToolResponse> {
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
  if (publicationCount >= CHAT_ARTIFACT_MAX_PER_TURN) {
    throw new Error(
      `This turn already published ${CHAT_ARTIFACT_MAX_PER_TURN} files, which is the limit.`,
    );
  }

  const file = await loadPublishableSandboxFile({
    sandbox: input.context.sandbox,
    workDirectory: input.context.workDirectory,
    requestedPath: input.input.path,
  });
  await input.context.checkAbort();

  return publishChatArtifactBytes({
    context: input.context,
    input: {
      filename: file.filename,
      mediaType: file.mediaType,
      bytes: file.bytes,
      ...(input.input.title !== undefined ? { title: input.input.title } : {}),
      ...(input.input.description !== undefined ? { description: input.input.description } : {}),
      ...(input.input.artifactId ? { artifactId: input.input.artifactId } : {}),
      ...(input.input.expectedVersion !== undefined
        ? { expectedVersion: input.input.expectedVersion }
        : {}),
    },
    toolCallId: input.toolCallId,
    preflightChecked: true,
  });
}

async function publishChatArtifactBytes(input: {
  context: ArtifactPersistenceContext;
  input: {
    filename: string;
    mediaType: string;
    bytes: Buffer;
    title?: string;
    description?: string;
    artifactId?: string;
    expectedVersion?: number;
  };
  toolCallId: string;
  preflightChecked?: boolean;
}): Promise<PublishArtifactToolResponse> {
  await input.context.checkAbort();
  if (!input.toolCallId.trim() || input.toolCallId.length > 500) {
    throw new Error("The host supplied an invalid tool call id.");
  }
  if (input.input.bytes.byteLength > CHAT_ARTIFACT_MAX_BYTES) {
    throw new Error("The file is larger than the 20 MB publication limit.");
  }
  const db = getDb();
  if (!input.preflightChecked) {
    const priorPublication = await loadToolCallPublication({
      turnId: input.context.turnId,
      toolCallId: input.toolCallId,
    });
    if (priorPublication) return { ok: true, artifact: priorPublication };
    const publicationCount = await countTurnPublications(db, input.context.turnId);
    if (publicationCount >= CHAT_ARTIFACT_MAX_PER_TURN) {
      throw new Error(
        `This turn already published ${CHAT_ARTIFACT_MAX_PER_TURN} files, which is the limit.`,
      );
    }
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

  const artifactId = existing?.id ?? `goat_chat_artifact_${randomUUID()}`;
  const artifactVersionId = `goat_chat_artifact_version_${randomUUID()}`;
  const version = (existing?.currentVersion ?? 0) + 1;
  const title = boundedText(input.input.title, 160) ?? existing?.title ?? input.input.filename;
  const description =
    input.input.description === undefined
      ? (existing?.description ?? undefined)
      : boundedText(input.input.description, 500);
  const contentSha256 = createHash("sha256").update(input.input.bytes).digest("hex");
  const blobPath = artifactBlobPath({
    workspaceId: input.context.workspaceId,
    artifactId,
    artifactVersionId,
    filename: input.input.filename,
  });
  const stored = await put(blobPath, input.input.bytes, {
    access: "private",
    addRandomSuffix: false,
    contentType: input.input.mediaType,
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
          filename: input.input.filename,
          mediaType: input.input.mediaType,
          sizeBytes: input.input.bytes.byteLength,
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
          filename: input.input.filename,
          mediaType: input.input.mediaType,
          sizeBytes: input.input.bytes.byteLength,
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

  const artifact: PublishedChatArtifact = {
    artifactId,
    artifactVersionId,
    version,
    title,
    ...(description ? { description } : {}),
    filename: input.input.filename,
    mediaType: input.input.mediaType,
    sizeBytes: input.input.bytes.byteLength,
    state: "ready",
  };
  logger.info("Published a generated chat file", {
    event: "opencompany.goat_chat_artifact_published",
    artifact_id: artifactId,
    artifact_version_id: artifactVersionId,
    version,
    media_type: input.input.mediaType,
    size_bytes: input.input.bytes.byteLength,
    chat_session_id: input.context.chatSessionId,
    codex_chat_turn_id: input.context.turnId,
    engine: input.context.engine,
  });
  return { ok: true, artifact };
}

export async function publishExternalEngineChatArtifact(input: {
  codexChatSessionId: string;
  codexChatTurnId: string;
  toolCallId: string;
  arguments: unknown;
  attemptId?: string;
  leaseId?: string;
  env: RunnerEnv;
  signal?: AbortSignal;
}): Promise<PublishArtifactToolResponse> {
  if (Boolean(input.attemptId) !== Boolean(input.leaseId)) {
    return { ok: false, error: "The engine capability is incomplete." };
  }
  if (
    input.attemptId &&
    input.leaseId &&
    !(await authorizePersistedExternalEngineToolCapability({
      capability: {
        codexChatSessionId: input.codexChatSessionId,
        codexChatTurnId: input.codexChatTurnId,
        attemptId: input.attemptId,
        leaseId: input.leaseId,
      },
    }))
  ) {
    return { ok: false, error: "This engine turn is no longer active." };
  }
  const [row] = await getDb()
    .select({
      session: codexChatSessions,
      turn: codexChatTurns,
    })
    .from(codexChatTurns)
    .innerJoin(codexChatSessions, eq(codexChatTurns.codexChatSessionId, codexChatSessions.id))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, codexChatSessions.workspaceId),
        eq(workspaceMembers.userWorkosId, codexChatSessions.userWorkosId),
      ),
    )
    .where(
      and(
        eq(codexChatTurns.id, input.codexChatTurnId),
        eq(codexChatTurns.codexChatSessionId, input.codexChatSessionId),
        ...(input.leaseId ? [eq(codexChatTurns.leaseId, input.leaseId)] : []),
      ),
    )
    .limit(1);
  if (
    !row ||
    (row.session.engine !== "claude_code" && row.session.engine !== "codex") ||
    row.session.status !== "running" ||
    row.session.activeTurnId !== row.turn.id ||
    row.turn.status !== "running" ||
    !row.session.workspaceId ||
    !row.session.sandboxId ||
    !row.turn.leaseId ||
    !row.turn.leaseOwner
  ) {
    return { ok: false, error: "This engine turn is no longer active." };
  }
  const checkAbort = async () => {
    if (input.signal?.aborted) throw new Error("The file publication was canceled.");
    const [active] = await getDb()
      .select({
        status: codexChatTurns.status,
        interruptAt: codexChatTurns.interruptRequestedAt,
      })
      .from(codexChatTurns)
      .where(
        and(
          eq(codexChatTurns.id, row.turn.id),
          eq(codexChatTurns.leaseId, row.turn.leaseId as string),
          eq(codexChatTurns.leaseOwner, row.turn.leaseOwner as string),
        ),
      )
      .limit(1);
    if (!active || active.status !== "running" || active.interruptAt) {
      throw new Error("This engine turn is no longer active.");
    }
  };
  try {
    await checkAbort();
    const sandbox = await connectSandbox({ sandboxId: row.session.sandboxId });
    if (!sandbox) return { ok: false, error: "The engine sandbox is no longer available." };
    const engine = row.session.engine as "codex" | "claude_code";
    return await publishChatArtifact({
      context: {
        sandbox,
        workDirectory: CLOUD_CODING_ENGINE_CONFIG[engine].workDirectory,
        workspaceId: row.session.workspaceId,
        userWorkosId: row.turn.userWorkosId,
        chatSessionId: row.turn.chatSessionId,
        codexChatSessionId: row.session.id,
        turnId: row.turn.id,
        assistantMessageId: row.turn.assistantMessageId,
        engine,
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

export async function publishInBandChatArtifact(input: {
  codexChatSessionId: string;
  codexChatTurnId: string;
  toolCallId: string;
  arguments: unknown;
  env: Pick<RunnerEnv, "blobReadWriteToken">;
  signal?: AbortSignal;
}): Promise<PublishArtifactToolResponse> {
  const [row] = await getDb()
    .select({ session: codexChatSessions, turn: codexChatTurns })
    .from(codexChatTurns)
    .innerJoin(codexChatSessions, eq(codexChatTurns.codexChatSessionId, codexChatSessions.id))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, codexChatSessions.workspaceId),
        eq(workspaceMembers.userWorkosId, codexChatSessions.userWorkosId),
      ),
    )
    .where(
      and(
        eq(codexChatTurns.id, input.codexChatTurnId),
        eq(codexChatTurns.codexChatSessionId, input.codexChatSessionId),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.session.engine !== "opencompany" ||
    row.session.status !== "running" ||
    row.session.activeTurnId !== row.turn.id ||
    row.turn.status !== "running" ||
    !row.session.workspaceId ||
    !row.turn.leaseId ||
    !row.turn.leaseOwner
  ) {
    return { ok: false, error: "This chat turn is no longer active." };
  }
  const checkAbort = async () => {
    if (input.signal?.aborted) throw new Error("The artifact publication was canceled.");
    const [active] = await getDb()
      .select({
        status: codexChatTurns.status,
        interruptAt: codexChatTurns.interruptRequestedAt,
      })
      .from(codexChatTurns)
      .where(
        and(
          eq(codexChatTurns.id, row.turn.id),
          eq(codexChatTurns.leaseId, row.turn.leaseId as string),
          eq(codexChatTurns.leaseOwner, row.turn.leaseOwner as string),
        ),
      )
      .limit(1);
    if (!active || active.status !== "running" || active.interruptAt) {
      throw new Error("This chat turn is no longer active.");
    }
  };

  try {
    const artifactInput = normalizeWriteArtifactInput(input.arguments);
    const bytes = Buffer.from(artifactInput.content, "utf8");
    return await publishChatArtifactBytes({
      context: {
        workspaceId: row.session.workspaceId,
        userWorkosId: row.turn.userWorkosId,
        chatSessionId: row.turn.chatSessionId,
        codexChatSessionId: row.session.id,
        turnId: row.turn.id,
        assistantMessageId: row.turn.assistantMessageId,
        engine: "opencompany",
        env: input.env,
        checkAbort,
      },
      input: {
        filename: artifactInput.filename,
        mediaType: "text/markdown",
        bytes,
        title: artifactInput.title,
        ...(artifactInput.description !== undefined
          ? { description: artifactInput.description }
          : {}),
        ...(artifactInput.artifact_id ? { artifactId: artifactInput.artifact_id } : {}),
        ...(artifactInput.expected_version !== undefined
          ? { expectedVersion: artifactInput.expected_version }
          : {}),
      },
      toolCallId: input.toolCallId,
    });
  } catch (error) {
    logger.warn("Failed to write an opencompany chat artifact", {
      event: "opencompany.goat_chat_artifact_write_failed",
      chat_session_id: row.turn.chatSessionId,
      codex_chat_turn_id: row.turn.id,
      engine: "opencompany",
      error: error instanceof Error ? error.message : "The artifact could not be published.",
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The artifact could not be published.",
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

function normalizeWriteArtifactInput(value: unknown): WriteArtifactToolInput {
  if (!isRecord(value)) throw new Error("write_artifact expects an object input.");
  const filename = requiredBoundedString(value.filename, "filename", 255);
  if (
    filename !== path.posix.basename(filename) ||
    path.posix.extname(filename).toLowerCase() !== ".md"
  ) {
    throw new Error("filename must be a Markdown filename ending in .md, without a path.");
  }
  const title = requiredBoundedString(value.title, "title", 160);
  if (typeof value.content !== "string") throw new Error("content must be a string.");
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
    filename,
    title,
    content: value.content,
    ...(value.description !== undefined
      ? { description: requiredBoundedString(value.description, "description", 500) }
      : {}),
    ...(artifactId ? { artifact_id: artifactId } : {}),
    ...(typeof expectedVersion === "number" ? { expected_version: expectedVersion } : {}),
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
  if (info.size > CHAT_ARTIFACT_MAX_BYTES) {
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
    .from(chatArtifacts)
    .where(
      and(
        eq(chatArtifacts.id, input.artifactId),
        eq(chatArtifacts.workspaceId, input.workspaceId),
        eq(chatArtifacts.userWorkosId, input.userWorkosId),
        eq(chatArtifacts.chatSessionId, input.chatSessionId),
        sql`${chatArtifacts.archivedAt} IS NULL`,
      ),
    )
    .limit(1);
  return artifact ?? null;
}

async function loadToolCallPublication(input: { turnId: string; toolCallId: string }) {
  const [row] = await getDb()
    .select({ artifact: chatArtifacts, version: chatArtifactVersions })
    .from(chatArtifactVersions)
    .innerJoin(chatArtifacts, eq(chatArtifactVersions.artifactId, chatArtifacts.id))
    .where(
      and(
        eq(chatArtifactVersions.sourceTurnId, input.turnId),
        eq(chatArtifactVersions.sourceToolCallId, input.toolCallId),
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
  context: ArtifactPersistenceContext;
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
      ) < ${CHAT_ARTIFACT_MAX_PER_TURN}
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
      ) < ${CHAT_ARTIFACT_MAX_PER_TURN}
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
