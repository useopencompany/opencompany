import { describe, expect, it, vi } from "vitest";
import {
  type AutoModelRoutingDependencies,
  AutoModelRoutingError,
  resolveAutoModelRouting,
} from "./auto-model-routing";

function dependencies(
  overrides: Partial<AutoModelRoutingDependencies> = {},
): AutoModelRoutingDependencies {
  return {
    loadEligibility: vi.fn(async () => ({ isMember: true, enabled: true })),
    loadIdempotentModel: vi.fn(async () => null),
    loadConversationModel: vi.fn(async () => null),
    loadAttachmentFormats: vi.fn(async ({ attachmentIds }) => attachmentIds.map(() => "image")),
    route: vi.fn(async () => ({
      model: "moonshotai/kimi-k3",
      tier: "frontier",
      reason: "analysis",
      classifier: {
        model: "google/gemini-3.1-flash-lite",
        durationMs: 12,
        outcome: "success",
      },
    })),
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    ...overrides,
  };
}

function resolve(deps: AutoModelRoutingDependencies) {
  return resolveAutoModelRouting({
    actorId: "user_1",
    workspaceId: "workspace_1",
    idempotencyKey: "send_1",
    conversationId: "conversation_1",
    clientMessageId: "message_1",
    prompt: "Analyze this",
    attachmentIds: [],
    dependencies: deps,
  });
}

describe("Auto model routing application service", () => {
  it("reuses the accepted command model before checking a disabled flag", async () => {
    const deps = dependencies({
      loadEligibility: vi.fn(async () => ({ isMember: true, enabled: false })),
      loadIdempotentModel: vi.fn(async () => "moonshotai/kimi-k2.6"),
    });

    await expect(resolve(deps)).resolves.toEqual({
      model: "moonshotai/kimi-k2.6",
      source: "idempotency_replay",
    });
    expect(deps.route).not.toHaveBeenCalled();
  });

  it("reuses the persisted conversation model without calling the provider", async () => {
    const deps = dependencies({
      loadConversationModel: vi.fn(async () => "anthropic/claude-sonnet-5"),
    });

    await expect(resolve(deps)).resolves.toEqual({
      model: "anthropic/claude-sonnet-5",
      source: "conversation",
    });
    expect(deps.route).not.toHaveBeenCalled();
  });

  it.each([
    ["revoked membership", { isMember: false, enabled: true }, "not_permitted"],
    ["disabled routing", { isMember: true, enabled: false }, "disabled"],
  ] as const)("rejects %s", async (_name, eligibility, code) => {
    await expect(
      resolve(dependencies({ loadEligibility: vi.fn(async () => eligibility) })),
    ).rejects.toMatchObject({ code } satisfies Partial<AutoModelRoutingError>);
  });

  it("rejects unavailable attachments before provider routing", async () => {
    const deps = dependencies({ loadAttachmentFormats: vi.fn(async () => []) });

    await expect(
      resolveAutoModelRouting({
        actorId: "user_1",
        workspaceId: "workspace_1",
        idempotencyKey: "send_1",
        clientMessageId: "message_1",
        prompt: "",
        attachmentIds: ["attachment_1"],
        dependencies: deps,
      }),
    ).rejects.toMatchObject({ code: "attachments_unavailable" });
    expect(deps.route).not.toHaveBeenCalled();
  });

  it("routes only after server authority and attachment checks pass", async () => {
    const deps = dependencies();

    await expect(resolve(deps)).resolves.toMatchObject({
      model: "moonshotai/kimi-k3",
      source: "routed",
    });
    expect(deps.route).toHaveBeenCalledWith({
      prompt: "Analyze this",
      attachments: [],
      actorId: "user_1",
      workspaceId: "workspace_1",
    });
  });
});
