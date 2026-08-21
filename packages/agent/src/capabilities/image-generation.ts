import { createHash, randomUUID } from "node:crypto";
import {
  CHAT_ARTIFACT_MAX_BYTES,
  CHAT_ARTIFACT_MAX_PER_TURN,
  type PublishedChatArtifact,
} from "@opencompany/agent-runtime";
import { calculatePlatformFeeUsdMicros, USD_MICROS_PER_DOLLAR } from "@opencompany/billing";
import { maybeTriggerAutoRefill } from "@opencompany/billing/auto-refill";
import {
  consumeCapabilityApprovalByToolCall,
  createCapabilityRun,
  getCapabilitySessionBudgetUsdMicros,
  isWorkspaceCapabilityEnabled,
  settleCapabilityRun,
  sumCapabilitySessionSpendUsdMicros,
} from "@opencompany/db/capabilities";
import { getDb } from "@opencompany/db/client";
import { getCreditBalanceUsdMicros, recordCreditDebit } from "@opencompany/db/credits";
import { type CapabilityRun, chatMessages } from "@opencompany/db/product-schema";
import {
  createGatewayAttribution,
  gatewayProviderOptions,
  METRICS,
  recordCounter,
  recordHistogram,
} from "@opencompany/telemetry";
import { del, put } from "@vercel/blob";
import { createGateway, generateImage, type ImageModelProviderMetadata } from "ai";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  type ActionExecuteContext,
  ActionExecutionError,
  ActionInvalidParamsError,
  type CapabilityQuote,
  type CapabilityTurnState,
} from "../actions/types";
import { downloadChatAttachment } from "../chat-attachment-storage";
import type { ManagedCapabilityImageActionSpec } from "./catalog";
import {
  admitCapabilityQuote,
  CAPABILITY_APPROVAL_EXPIRES_MS,
  capabilityTurnSnapshot,
  isManagedCapabilitiesKilled,
  isManagedCapabilityActionKilled,
  releaseCapabilityQuote,
  storeCapabilityQuote,
} from "./execute";
import { hashCapabilityInput } from "./hash";

export const IMAGE_GENERATION_TIMEOUT_MS = 125_000;
export const IMAGE_GENERATION_FLASH_MODEL = "google/gemini-3.1-flash-image";
export const IMAGE_GENERATION_PRO_MODEL = "google/gemini-3-pro-image";

const IMAGE_GENERATION_FLASH_MAX_COST_USD_MICROS = 500_000;
const IMAGE_GENERATION_PRO_MAX_COST_USD_MICROS = 1_000_000;
const IMAGE_GENERATION_SOURCE = "image" as const;
const IMAGE_GENERATION_PROVIDER = "vercel-ai-gateway";

type ImageGenerationParams = {
  prompt: string;
  referenceImageAttachmentId?: string;
  aspectRatio: `${number}:${number}`;
  resolution: "1K" | "2K";
  quality: "standard" | "pro";
  title?: string;
  model: typeof IMAGE_GENERATION_FLASH_MODEL | typeof IMAGE_GENERATION_PRO_MODEL;
};

export async function evaluateImageGenerationApproval(input: {
  spec: ManagedCapabilityImageActionSpec;
  params: Record<string, unknown>;
  toolCallId: string;
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  turnState: CapabilityTurnState;
  now?: () => Date;
}): Promise<boolean> {
  try {
    if (isManagedCapabilitiesKilled() || isManagedCapabilityActionKilled(input.spec.id)) {
      return false;
    }
    if (
      !(await isWorkspaceCapabilityEnabled({
        workspaceId: input.workspaceId,
        source: IMAGE_GENERATION_SOURCE,
      }))
    ) {
      return false;
    }

    const mapped = imageGenerationParams(input.spec, input.params);
    const inputHash = hashCapabilityInput({ action: input.spec.id, params: input.params });
    const snapshot = await capabilityTurnSnapshot(input.turnState);
    const cached = snapshot.quotesByToolCallId.get(input.toolCallId);
    if (cached) {
      return cached.inputHash === inputHash && cached.decision === "approval_required";
    }
    const quote = imageGenerationQuote(inputHash, mapped.quality);
    const [budgetUsdMicros, spentUsdMicros] = await Promise.all([
      getCapabilitySessionBudgetUsdMicros(input.workspaceId),
      sumCapabilitySessionSpendUsdMicros({
        workspaceId: input.workspaceId,
        chatSessionId: input.chatSessionId,
        excludeToolCallIds: snapshot.admittedToolCallIds,
      }),
    ]);
    if (
      spentUsdMicros + snapshot.quotedTotalUsdMicros + quote.quoteTotalCostUsdMicros <=
      budgetUsdMicros
    ) {
      const admitted = await admitCapabilityQuote(
        input.turnState,
        input.toolCallId,
        { ...quote, decision: "auto" },
        budgetUsdMicros - spentUsdMicros,
      );
      if (admitted) return false;
    }

    const createdAt = input.now?.() ?? new Date();
    const run = await createCapabilityRun({
      workspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      chatSessionId: input.chatSessionId,
      toolCallId: input.toolCallId,
      source: IMAGE_GENERATION_SOURCE,
      action: input.spec.id,
      inputHash,
      provider: IMAGE_GENERATION_PROVIDER,
      endpoint: mapped.model,
      status: "awaiting_approval",
      quoteProviderCostUsdMicros: quote.quoteProviderCostUsdMicros,
      quotePlatformFeeUsdMicros: quote.quotePlatformFeeUsdMicros,
      quoteTotalCostUsdMicros: quote.quoteTotalCostUsdMicros,
      approvalExpiresAt: new Date(createdAt.getTime() + CAPABILITY_APPROVAL_EXPIRES_MS),
      now: createdAt,
    });
    await storeCapabilityQuote(
      input.turnState,
      input.toolCallId,
      { ...quote, decision: "approval_required", runId: run.id },
      false,
    );
    return true;
  } catch {
    return false;
  }
}

export async function executeImageGenerationCapability(input: {
  spec: ManagedCapabilityImageActionSpec;
  params: Record<string, unknown>;
  context: ActionExecuteContext;
  generateImageImpl?: typeof generateImage;
  now?: () => Date;
}) {
  if (isManagedCapabilitiesKilled() || isManagedCapabilityActionKilled(input.spec.id)) {
    throw new ActionExecutionError("disabled", "AI image generation is temporarily unavailable.");
  }
  const apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) {
    throw new ActionExecutionError("disabled", "AI image generation is not configured.");
  }
  const { workspaceId, chatSessionId, capabilityTurnState: turnState } = input.context;
  if (!workspaceId || !chatSessionId || !turnState) {
    throw new ActionExecutionError(
      "provider_error",
      "The AI image generation context is incomplete.",
    );
  }
  if (
    !input.context.toolCallId ||
    !input.context.sourceTurnId ||
    !input.context.sourceMessageId ||
    !input.context.sourceEngine
  ) {
    throw new ActionExecutionError(
      "provider_error",
      "The generated image could not be attached to this chat turn.",
    );
  }
  if (
    !(await isWorkspaceCapabilityEnabled({
      workspaceId,
      source: IMAGE_GENERATION_SOURCE,
    }))
  ) {
    throw new ActionExecutionError(
      "disabled",
      "AI image generation is disabled for this workspace.",
    );
  }

  const mapped = imageGenerationParams(input.spec, input.params);
  const inputHash = hashCapabilityInput({ action: input.spec.id, params: input.params });
  const toolCallId = input.context.toolCallId;
  const snapshot = await capabilityTurnSnapshot(turnState);
  const cachedQuote = snapshot.quotesByToolCallId.get(toolCallId);
  if (cachedQuote && cachedQuote.inputHash !== inputHash) {
    throw new ActionExecutionError(
      "provider_error",
      "The AI image generation input changed after it was quoted.",
    );
  }
  const quote = cachedQuote ?? {
    ...imageGenerationQuote(inputHash, mapped.quality),
    decision: "auto" as const,
  };

  await assertArtifactPublicationAvailable(input.context.sourceTurnId);
  const referenceImage = mapped.referenceImageAttachmentId
    ? await loadReferenceImage({
        chatSessionId,
        attachmentId: mapped.referenceImageAttachmentId,
      })
    : null;

  const balanceUsdMicros = await getCreditBalanceUsdMicros(workspaceId);
  if (balanceUsdMicros < quote.quoteTotalCostUsdMicros) {
    throw new ActionExecutionError(
      "insufficient_credits",
      "This workspace does not have enough credits for the maximum image generation cost.",
    );
  }

  const auditRun = await admitImageGenerationRun({
    spec: input.spec,
    context: { ...input.context, workspaceId, chatSessionId, toolCallId },
    inputHash,
    mapped,
    quote,
    snapshot,
    turnState,
    now: input.now?.() ?? new Date(),
  });

  const gateway = createGateway({ apiKey });
  let result: Awaited<ReturnType<typeof generateImage>>;
  try {
    result = await (input.generateImageImpl ?? generateImage)({
      model: gateway.image(mapped.model),
      prompt: imageGenerationPrompt(mapped.prompt, referenceImage?.bytes),
      aspectRatio: mapped.aspectRatio,
      abortSignal: input.context.signal,
      maxRetries: 1,
      providerOptions: gatewayProviderOptions(
        createGatewayAttribution({
          userWorkosId: input.context.userWorkosId,
          feature: "capability",
          chatSessionId,
        }),
        {
          google: { imageConfig: { imageSize: mapped.resolution } },
        },
      ),
    });
  } catch (error) {
    await settleFailedImageGeneration(auditRun, error).catch(() => undefined);
    throw error;
  }

  const cost = imageGenerationCost(result.providerMetadata);
  if (!cost || cost.providerCostUsdMicros > quote.quoteProviderCostUsdMicros) {
    await settleFailedImageGeneration(
      auditRun,
      new Error("The AI Gateway returned an invalid or unexpectedly high generation cost."),
    ).catch(() => undefined);
    throw new ActionExecutionError(
      "provider_error",
      "The generated image could not be billed safely, so it was not published.",
    );
  }

  let artifact: PublishedChatArtifact;
  try {
    artifact = await publishGeneratedImage({
      image: result.image.uint8Array,
      mediaType: result.image.mediaType,
      title: mapped.title ?? "Generated image",
      prompt: mapped.prompt,
      workspaceId,
      userWorkosId: input.context.userWorkosId,
      chatSessionId,
      sourceTurnId: input.context.sourceTurnId,
      sourceMessageId: input.context.sourceMessageId,
      sourceToolCallId: toolCallId,
      sourceEngine: input.context.sourceEngine,
    });
  } catch (error) {
    await settleSuccessfulImageGeneration({ auditRun, cost }).catch(() => undefined);
    throw new ActionExecutionError(
      "provider_error",
      error instanceof Error
        ? `The image was generated but could not be published: ${error.message}`
        : "The image was generated but could not be published.",
    );
  }

  await settleSuccessfulImageGeneration({ auditRun, cost });
  return {
    source: IMAGE_GENERATION_SOURCE,
    action: input.spec.id,
    model: mapped.model,
    ...(mapped.referenceImageAttachmentId
      ? { referenceImageAttachmentId: mapped.referenceImageAttachmentId }
      : {}),
    totalCostUsdMicros: cost.totalCostUsdMicros,
    artifact,
  };
}

function imageGenerationParams(
  spec: ManagedCapabilityImageActionSpec,
  raw: Record<string, unknown>,
): ImageGenerationParams {
  const providerInput = spec.mapInput(raw).providerInput;
  const prompt = providerInput.prompt;
  const aspectRatio = providerInput.aspectRatio;
  const resolution = providerInput.resolution;
  const quality = providerInput.quality;
  const model = providerInput.model;
  if (
    typeof prompt !== "string" ||
    typeof aspectRatio !== "string" ||
    (resolution !== "1K" && resolution !== "2K") ||
    (quality !== "standard" && quality !== "pro") ||
    (model !== IMAGE_GENERATION_FLASH_MODEL && model !== IMAGE_GENERATION_PRO_MODEL)
  ) {
    throw new ActionInvalidParamsError("The image generation parameters are invalid.");
  }
  return {
    prompt,
    aspectRatio: aspectRatio as `${number}:${number}`,
    resolution,
    quality,
    model,
    ...(typeof providerInput.referenceImageAttachmentId === "string"
      ? { referenceImageAttachmentId: providerInput.referenceImageAttachmentId }
      : {}),
    ...(typeof providerInput.title === "string" ? { title: providerInput.title } : {}),
  };
}

function imageGenerationQuote(inputHash: string, quality: "standard" | "pro") {
  const quoteProviderCostUsdMicros =
    quality === "pro"
      ? IMAGE_GENERATION_PRO_MAX_COST_USD_MICROS
      : IMAGE_GENERATION_FLASH_MAX_COST_USD_MICROS;
  const quotePlatformFeeUsdMicros = calculatePlatformFeeUsdMicros(quoteProviderCostUsdMicros);
  return {
    inputHash,
    quoteProviderCostUsdMicros,
    quotePlatformFeeUsdMicros,
    quoteTotalCostUsdMicros: quoteProviderCostUsdMicros + quotePlatformFeeUsdMicros,
  };
}

async function admitImageGenerationRun(input: {
  spec: ManagedCapabilityImageActionSpec;
  context: ActionExecuteContext & {
    workspaceId: string;
    chatSessionId: string;
    toolCallId: string;
  };
  inputHash: string;
  mapped: ImageGenerationParams;
  quote: CapabilityQuote;
  snapshot: Awaited<ReturnType<typeof capabilityTurnSnapshot>>;
  turnState: CapabilityTurnState;
  now: Date;
}) {
  const cached = input.snapshot.quotesByToolCallId.get(input.context.toolCallId);
  if (cached?.decision === "auto") {
    return createImageGenerationRun(input);
  }
  const approved = await consumeCapabilityApprovalByToolCall({
    toolCallId: input.context.toolCallId,
    userWorkosId: input.context.userWorkosId,
    workspaceId: input.context.workspaceId,
    chatSessionId: input.context.chatSessionId,
    action: input.spec.id,
    inputHash: input.inputHash,
    quoteTotalCostUsdMicros: input.quote.quoteTotalCostUsdMicros,
    now: input.now,
  });
  if (approved) return approved;

  const [budgetUsdMicros, spentUsdMicros] = await Promise.all([
    getCapabilitySessionBudgetUsdMicros(input.context.workspaceId),
    sumCapabilitySessionSpendUsdMicros({
      workspaceId: input.context.workspaceId,
      chatSessionId: input.context.chatSessionId,
      excludeToolCallIds: input.snapshot.admittedToolCallIds,
    }),
  ]);
  if (
    spentUsdMicros + input.snapshot.quotedTotalUsdMicros + input.quote.quoteTotalCostUsdMicros >
    budgetUsdMicros
  ) {
    throw new ActionExecutionError(
      "approval_required",
      "This image generation still exceeds the session budget. Ask again only if the user wants a fresh approval card.",
    );
  }
  const admitted = await admitCapabilityQuote(
    input.turnState,
    input.context.toolCallId,
    { ...input.quote, decision: "auto" },
    budgetUsdMicros - spentUsdMicros,
  );
  if (!admitted) {
    throw new ActionExecutionError(
      "approval_required",
      "Concurrent paid actions consumed the remaining session budget. Ask again only if the user wants a fresh approval card.",
    );
  }
  try {
    return await createImageGenerationRun(input);
  } catch (error) {
    await releaseCapabilityQuote(input.turnState, input.context.toolCallId);
    throw error;
  }
}

function createImageGenerationRun(input: {
  spec: ManagedCapabilityImageActionSpec;
  context: ActionExecuteContext & {
    workspaceId: string;
    chatSessionId: string;
    toolCallId: string;
  };
  inputHash: string;
  mapped: ImageGenerationParams;
  quote: CapabilityQuote;
  now: Date;
}) {
  return createCapabilityRun({
    workspaceId: input.context.workspaceId,
    userWorkosId: input.context.userWorkosId,
    chatSessionId: input.context.chatSessionId,
    toolCallId: input.context.toolCallId,
    source: IMAGE_GENERATION_SOURCE,
    action: input.spec.id,
    inputHash: input.inputHash,
    provider: IMAGE_GENERATION_PROVIDER,
    endpoint: input.mapped.model,
    status: "executing",
    quoteProviderCostUsdMicros: input.quote.quoteProviderCostUsdMicros,
    quotePlatformFeeUsdMicros: input.quote.quotePlatformFeeUsdMicros,
    quoteTotalCostUsdMicros: input.quote.quoteTotalCostUsdMicros,
    now: input.now,
  });
}

async function loadReferenceImage(input: { chatSessionId: string; attachmentId: string }) {
  const rows = await getDb()
    .select({ attachments: chatMessages.attachments })
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, input.chatSessionId), eq(chatMessages.role, "user")))
    .orderBy(asc(chatMessages.createdAt));
  const attachment = rows
    .flatMap((row) => row.attachments ?? [])
    .find((candidate) => candidate.id === input.attachmentId);
  if (!attachment) {
    throw new ActionInvalidParamsError(
      '"referenceImageAttachmentId" must be the exact id of an image attached in this chat.',
    );
  }
  if (attachment.kind !== "image" || !attachment.mediaType.startsWith("image/")) {
    throw new ActionInvalidParamsError("The selected reference attachment must be an image.");
  }
  return { attachment, bytes: await downloadChatAttachment(attachment.blobUrl) };
}

async function assertArtifactPublicationAvailable(sourceTurnId: string) {
  const result = await getDb().execute(sql`
    SELECT count(*)::int AS count
    FROM goat.chat_artifact_versions
    WHERE source_turn_id = ${sourceTurnId}
  `);
  const publicationCount = rowsFromExecute<{ count: number }>(result)[0]?.count ?? 0;
  if (publicationCount >= CHAT_ARTIFACT_MAX_PER_TURN) {
    throw new ActionExecutionError(
      "provider_error",
      `This turn already published ${CHAT_ARTIFACT_MAX_PER_TURN} files, which is the limit.`,
    );
  }
}

export function imageGenerationPrompt(prompt: string, referenceImage?: Uint8Array) {
  return referenceImage ? { text: prompt, images: [referenceImage] } : prompt;
}

export function imageGenerationCost(providerMetadata: ImageModelProviderMetadata) {
  const gateway = asRecord(providerMetadata.gateway);
  if (!gateway || typeof gateway.cost !== "string") return null;
  const costUsd = Number(gateway.cost);
  if (!Number.isFinite(costUsd) || costUsd < 0) return null;
  const providerCostUsdMicros = Math.round(costUsd * USD_MICROS_PER_DOLLAR);
  const platformFeeUsdMicros = calculatePlatformFeeUsdMicros(providerCostUsdMicros);
  return {
    providerCostUsdMicros,
    platformFeeUsdMicros,
    totalCostUsdMicros: providerCostUsdMicros + platformFeeUsdMicros,
    generationId:
      typeof gateway.generationId === "string" && gateway.generationId
        ? gateway.generationId
        : undefined,
  };
}

async function settleSuccessfulImageGeneration(input: {
  auditRun: CapabilityRun;
  cost: NonNullable<ReturnType<typeof imageGenerationCost>>;
}) {
  if (input.cost.totalCostUsdMicros > 0) {
    await recordCreditDebit({
      workspaceId: input.auditRun.workspaceId,
      userWorkosId: input.auditRun.userWorkosId,
      source: "capability_usage",
      idempotencyKey: `capability:${input.cost.generationId ?? input.auditRun.id}`,
      providerCostUsdMicros: input.cost.providerCostUsdMicros,
      platformFeeUsdMicros: input.cost.platformFeeUsdMicros,
      totalCostUsdMicros: input.cost.totalCostUsdMicros,
      chatSessionId: input.auditRun.chatSessionId,
      costBasis: {
        kind: "paid_capability",
        priceType: "AI_GATEWAY_REPORTED",
        billedUnits: 1,
      },
      metadata: {
        capabilitySource: input.auditRun.source,
        capabilityAction: input.auditRun.action,
        capabilityRunId: input.auditRun.id,
      },
    });
  }
  await settleCapabilityRun({
    id: input.auditRun.id,
    status: "succeeded",
    resultCount: 1,
    providerCostUsdMicros: input.cost.providerCostUsdMicros,
    platformFeeUsdMicros: input.cost.platformFeeUsdMicros,
    totalCostUsdMicros: input.cost.totalCostUsdMicros,
  });
  recordImageGenerationSettlementMetrics(
    input.auditRun,
    "succeeded",
    input.cost.providerCostUsdMicros,
  );
  if (input.cost.totalCostUsdMicros > 0) {
    void maybeTriggerAutoRefill(input.auditRun.workspaceId);
  }
}

async function settleFailedImageGeneration(auditRun: CapabilityRun, error: unknown) {
  await settleCapabilityRun({
    id: auditRun.id,
    status: "failed",
    providerCostUsdMicros: 0,
    platformFeeUsdMicros: 0,
    totalCostUsdMicros: 0,
    errorCode: "image_generation_failed",
    errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Image generation failed.",
  });
  recordImageGenerationSettlementMetrics(auditRun, "failed", 0);
}

function recordImageGenerationSettlementMetrics(
  auditRun: CapabilityRun,
  outcome: "succeeded" | "failed",
  providerCostUsdMicros: number,
) {
  const attributes = {
    "goat.capability_source": auditRun.source,
    "goat.capability_action": auditRun.action,
    "goat.outcome": outcome,
  };
  recordCounter(METRICS.capabilityRunsTotal, 1, attributes);
  recordCounter(METRICS.capabilityProviderCostUsdMicros, providerCostUsdMicros, attributes);
  recordHistogram(
    METRICS.capabilitySettlementLagMs,
    Math.max(0, Date.now() - auditRun.createdAt.getTime()),
    attributes,
  );
}

async function publishGeneratedImage(input: {
  image: Uint8Array;
  mediaType: string;
  title: string;
  prompt: string;
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  sourceTurnId: string;
  sourceMessageId: string;
  sourceToolCallId: string;
  sourceEngine: "opencompany" | "codex" | "claude_code";
}): Promise<PublishedChatArtifact> {
  if (
    !input.mediaType.startsWith("image/") ||
    input.image.byteLength === 0 ||
    input.image.byteLength > CHAT_ARTIFACT_MAX_BYTES
  ) {
    throw new Error("The provider did not return a valid image file.");
  }
  const artifactId = `goat_chat_artifact_${randomUUID()}`;
  const artifactVersionId = `goat_chat_artifact_version_${randomUUID()}`;
  const extension = imageExtension(input.mediaType);
  const filename = `generated-image.${extension}`;
  const title = input.title.trim().slice(0, 160) || "Generated image";
  const description = `Generated with Nano Banana from: ${input.prompt}`.slice(0, 500);
  const contentSha256 = createHash("sha256").update(input.image).digest("hex");
  const blobPathname = `goat-chat-artifacts-v1/${input.workspaceId}/${artifactId}/${artifactVersionId}/${filename}`;
  const stored = await put(blobPathname, Buffer.from(input.image), {
    access: "private",
    addRandomSuffix: false,
    contentType: input.mediaType,
  });
  try {
    const result = await getDb().execute(sql`
      WITH publication_lock AS (
        SELECT pg_advisory_xact_lock(hashtextextended(${input.sourceTurnId}, 0))
      ), publication_slot AS (
        SELECT 1
        FROM publication_lock
        WHERE (
          SELECT count(*)
          FROM goat.chat_artifact_versions
          WHERE source_turn_id = ${input.sourceTurnId}
        ) < ${CHAT_ARTIFACT_MAX_PER_TURN}
      ), inserted_artifact AS (
        INSERT INTO goat.chat_artifacts (
          id, workspace_id, user_workos_id, chat_session_id, title, description,
          current_version, created_at, updated_at
        ) SELECT
          ${artifactId}, ${input.workspaceId}, ${input.userWorkosId}, ${input.chatSessionId},
          ${title}, ${description}, 1, now(), now()
        FROM publication_slot
        RETURNING id
      ), inserted_version AS (
        INSERT INTO goat.chat_artifact_versions (
        id, artifact_id, version, title, description, filename, media_type, size_bytes,
        content_sha256, blob_pathname, source_engine, source_tool_call_id,
        source_turn_id, source_message_id, created_at
        )
        SELECT
          ${artifactVersionId}, inserted_artifact.id, 1, ${title}, ${description}, ${filename},
          ${input.mediaType}, ${input.image.byteLength}, ${contentSha256}, ${stored.pathname},
          ${input.sourceEngine}, ${input.sourceToolCallId}, ${input.sourceTurnId},
          ${input.sourceMessageId}, now()
        FROM inserted_artifact
        RETURNING id
      )
      SELECT id FROM inserted_version
    `);
    if (!rowsFromExecute<{ id: string }>(result)[0]?.id) {
      throw new Error(
        `This turn already published ${CHAT_ARTIFACT_MAX_PER_TURN} files, which is the limit.`,
      );
    }
  } catch (error) {
    await del(stored.pathname).catch(() => undefined);
    throw error;
  }
  return {
    artifactId,
    artifactVersionId,
    version: 1,
    title,
    description,
    filename,
    mediaType: input.mediaType,
    sizeBytes: input.image.byteLength,
    state: "ready",
  };
}

function imageExtension(mediaType: string) {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: T[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
