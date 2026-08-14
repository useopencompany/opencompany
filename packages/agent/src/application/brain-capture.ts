import { createHash } from "node:crypto";
import type { CodexBrainCaptureGatewayResponse } from "@opencompany/agent-runtime";
import type { SaveToBrainToolOutput, StoredChatMessage } from "../chat-ui";

export type BrainCaptureContext = {
  actorId: string;
  workspaceId: string;
  brainRef: string | null;
  allowDefaultBrain?: boolean;
  conversationId: string;
  messageId: string;
};

export type BrainCaptureCommand = {
  sessionId: string;
  runId: string;
  content?: string;
  title?: string;
  intent?: string;
  sourceRef?: string;
  integrationId?: string;
  fallbackContent?: string;
  attachmentIds?: string[];
};

type BrainCaptureResult =
  | {
      ok: true;
      draftBrainId: string;
      path: string;
      title: string;
      alreadyCaptured?: boolean;
      quotaPaused?: boolean;
    }
  | { ok: false; error: string };

export type BrainCaptureServiceDependencies = {
  loadContext: (command: BrainCaptureCommand) => Promise<BrainCaptureContext | null>;
  defaultBrainSlug: string;
  getBrainAccess: (input: {
    actorId: string;
    brainRef: string;
  }) => Promise<{ brain: { workspaceId: string } } | null>;
  listBrains: (input: {
    actorId: string;
    workspaceId: string;
  }) => Promise<readonly { id: string; slug: string }[]>;
  capture: (input: {
    brainRef: string;
    actorId: string;
    text?: string;
    title?: string;
    intent?: string;
    sourceRef?: string;
    integrationId?: string;
    fallbackText?: string;
    source: {
      kind: "chat";
      connectionId: string;
      itemId: string;
      idempotencyKey: string;
    };
  }) => Promise<BrainCaptureResult>;
  loadMessages: (
    conversationId: string,
  ) => Promise<readonly Pick<StoredChatMessage, "role" | "attachments">[]>;
  saveAttachments: (input: {
    brainRef: string;
    actorId: string;
    attachmentIds: string[];
    sessionMessages: readonly Pick<StoredChatMessage, "role" | "attachments">[];
  }) => Promise<SaveToBrainToolOutput>;
  onError?: (error: unknown, command: BrainCaptureCommand) => void;
};

export async function executeBrainCaptureService(input: {
  command: BrainCaptureCommand;
  dependencies: BrainCaptureServiceDependencies;
}): Promise<CodexBrainCaptureGatewayResponse> {
  const { dependencies } = input;
  const context = await dependencies.loadContext(input.command);
  if (!context) {
    return {
      ok: false,
      error: "This Codex turn can no longer save to the pinned Brain.",
    };
  }

  let brainRef = context.brainRef;
  if (!brainRef && context.allowDefaultBrain) {
    const brains = await dependencies.listBrains({
      actorId: context.actorId,
      workspaceId: context.workspaceId,
    });
    brainRef =
      brains.find((candidate) => candidate.slug === dependencies.defaultBrainSlug)?.id ??
      brains[0]?.id ??
      null;
  }
  if (!brainRef) {
    return { ok: false, error: "This chat does not have an accessible Brain." };
  }
  const access = await dependencies.getBrainAccess({
    actorId: context.actorId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspaceId) {
    return {
      ok: false,
      error: "You no longer have access to the Brain pinned to this Codex chat.",
    };
  }

  const content = optionalString(input.command.content);
  const title = optionalString(input.command.title);
  const intent = optionalString(input.command.intent);
  const sourceRef = optionalString(input.command.sourceRef);
  const integrationId = optionalString(input.command.integrationId);
  const fallbackContent = optionalString(input.command.fallbackContent);
  const attachmentIds = input.command.attachmentIds ?? [];
  if (!content && !sourceRef && attachmentIds.length === 0) {
    return { ok: false, error: "save_to_brain needs content, sourceRef, or attachmentIds." };
  }

  try {
    if (attachmentIds.length > 0) {
      const sessionMessages = await dependencies.loadMessages(context.conversationId);
      return await dependencies.saveAttachments({
        brainRef,
        actorId: context.actorId,
        attachmentIds,
        sessionMessages,
      });
    }
    const captured = await dependencies.capture({
      brainRef,
      actorId: context.actorId,
      ...(content ? { text: content } : {}),
      ...(title ? { title } : {}),
      ...(intent ? { intent } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      ...(integrationId ? { integrationId } : {}),
      ...(fallbackContent ? { fallbackText: fallbackContent } : {}),
      source: {
        kind: "chat",
        connectionId: context.conversationId,
        itemId: context.messageId,
        idempotencyKey: brainCaptureIdempotencyKey({
          brainRef,
          messageId: context.messageId,
          content,
          title,
          intent,
          sourceRef,
          integrationId,
          fallbackContent,
        }),
      },
    });
    if (!captured.ok) return captured;
    return {
      ok: true,
      status: captured.quotaPaused
        ? "paused_by_plan"
        : captured.alreadyCaptured
          ? "already_captured"
          : "captured",
      ...(captured.quotaPaused
        ? {
            message:
              "Saved to the brain inbox. Ingestion is paused by the workspace plan; see Settings → Usage or Billing to review the limit or upgrade.",
          }
        : {}),
      draftId: captured.draftBrainId,
      path: captured.path,
      title: captured.title,
    };
  } catch (error) {
    dependencies.onError?.(error, input.command);
    return {
      ok: false,
      error: "The Codex Brain capture could not be saved.",
    };
  }
}

function brainCaptureIdempotencyKey(input: {
  brainRef: string;
  messageId: string;
  content: string | null;
  title: string | null;
  intent: string | null;
  sourceRef: string | null;
  integrationId: string | null;
  fallbackContent: string | null;
}) {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.brainRef,
        input.messageId,
        input.content,
        input.title,
        input.intent,
        input.sourceRef,
        input.integrationId,
        input.fallbackContent,
      ]),
    )
    .digest("hex");
  return `codex-save:${hash}`;
}

function optionalString(value: string | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
