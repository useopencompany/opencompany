export type AutoModelRoutingErrorCode =
  | "not_permitted"
  | "disabled"
  | "attachments_unavailable"
  | "unavailable";

export class AutoModelRoutingError extends Error {
  constructor(
    readonly code: AutoModelRoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AutoModelRoutingError";
  }
}

export type AutoModelRoutingResolution = {
  model: string;
  source: "idempotency_replay" | "conversation" | "routed";
  routing?: AutoModelRoutingDecision;
};

export type AutoModelRoutingDecision = {
  model: string;
  tier: string;
  reason: string;
  classifier: {
    model: string;
    durationMs: number;
    outcome: string;
  };
};

export type AutoModelRoutingDependencies = {
  loadEligibility: (input: {
    actorId: string;
    workspaceId: string;
  }) => Promise<{ isMember: boolean; enabled: boolean }>;
  loadIdempotentModel: (input: {
    actorId: string;
    workspaceId: string;
    idempotencyKey: string;
  }) => Promise<string | null>;
  loadConversationModel: (input: {
    actorId: string;
    workspaceId: string;
    conversationId: string;
  }) => Promise<string | null>;
  loadAttachmentFormats: (input: {
    actorId: string;
    workspaceId: string;
    clientMessageId: string | undefined;
    attachmentIds: readonly string[];
    now: Date;
  }) => Promise<readonly string[]>;
  route: (input: {
    prompt: string;
    attachments: readonly { kind: string }[];
    actorId: string;
    workspaceId: string;
  }) => Promise<AutoModelRoutingDecision>;
  now: () => Date;
};

export async function resolveAutoModelRouting(input: {
  actorId: string;
  workspaceId: string;
  idempotencyKey: string;
  conversationId?: string;
  clientMessageId?: string;
  prompt: string;
  attachmentIds: readonly string[];
  dependencies: AutoModelRoutingDependencies;
}): Promise<AutoModelRoutingResolution> {
  const eligibility = await input.dependencies.loadEligibility(input);
  if (!eligibility.isMember) {
    throw new AutoModelRoutingError("not_permitted", "Workspace membership is required.");
  }

  const replayModel = await input.dependencies.loadIdempotentModel(input);
  if (replayModel) return { model: replayModel, source: "idempotency_replay" };
  if (!eligibility.enabled) {
    throw new AutoModelRoutingError("disabled", "Auto model routing is not enabled.");
  }

  if (input.conversationId) {
    const conversationModel = await input.dependencies.loadConversationModel({
      actorId: input.actorId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
    });
    if (conversationModel) return { model: conversationModel, source: "conversation" };
  }

  const attachmentFormats = await input.dependencies.loadAttachmentFormats({
    actorId: input.actorId,
    workspaceId: input.workspaceId,
    clientMessageId: input.clientMessageId,
    attachmentIds: input.attachmentIds,
    now: input.dependencies.now(),
  });
  if (attachmentFormats.length !== input.attachmentIds.length) {
    throw new AutoModelRoutingError(
      "attachments_unavailable",
      "One or more attachments are unavailable.",
    );
  }
  const routing = await input.dependencies.route({
    prompt: input.prompt,
    attachments: attachmentFormats.map((kind) => ({ kind })),
    actorId: input.actorId,
    workspaceId: input.workspaceId,
  });
  return { model: routing.model, source: "routed", routing };
}
