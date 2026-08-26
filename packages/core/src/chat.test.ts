import { describe, expect, it, vi } from "vitest";
import { type Actor, CHAT_READ_PERMISSION, CHAT_WRITE_PERMISSION } from "./actor";
import {
  ChatApplicationService,
  type ChatRepository,
  CoreError,
  type CreateMessageCommand,
} from "./chat";

describe("ChatApplicationService", () => {
  it("passes the authenticated actor to the repository instead of accepting workspace input", async () => {
    const repository = fakeRepository();
    const service = new ChatApplicationService(repository);

    await expect(
      service.createMessage(actor(), {
        idempotencyKey: "send-1",
        content: "  Hello from Chat  ",
        engine: "opencompany",
        model: "openai/gpt-5.5",
      }),
    ).resolves.toMatchObject({ runId: "run_1" });

    expect(repository.createMessageAndRun).toHaveBeenCalledWith({
      actor: actor(),
      command: {
        idempotencyKey: "send-1",
        content: "Hello from Chat",
        engine: "opencompany",
        model: "openai/gpt-5.5",
      },
    });
  });

  it("normalizes client identifiers and rejects ambiguous conversation targets", async () => {
    const repository = fakeRepository();
    const service = new ChatApplicationService(repository);

    await service.createMessage(actor(), {
      idempotencyKey: " send-2 ",
      clientConversationId: " conversation_1 ",
      clientMessageId: " message_1 ",
      content: "Continue",
      engine: "opencompany",
      model: "openai/gpt-5.5",
    });
    expect(repository.createMessageAndRun).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          idempotencyKey: "send-2",
          clientConversationId: "conversation_1",
          clientMessageId: "message_1",
        }),
      }),
    );

    expect(() =>
      service.createMessage(actor(), {
        idempotencyKey: "send-3",
        conversationId: "conversation_1",
        clientConversationId: "conversation_2",
        content: "Ambiguous",
        engine: "opencompany",
        model: "openai/gpt-5.5",
      }),
    ).toThrowError(CoreError);
  });

  it("requires explicit Chat permissions and validates commands before persistence", () => {
    const repository = fakeRepository();
    const service = new ChatApplicationService(repository);

    expect(() =>
      service.createMessage(actor({ permissions: [CHAT_READ_PERMISSION] }), command()),
    ).toThrowError(/not allowed/i);
    expect(() => service.createMessage(actor(), command({ content: " " }))).toThrowError(
      /content or an attachment is required/i,
    );
    expect(() =>
      service.createMessage(actor(), command({ idempotencyKey: "contains a space" })),
    ).toThrowError(/Idempotency-Key/i);
    expect(repository.createMessageAndRun).not.toHaveBeenCalled();
  });

  it("bounds list and event reads before calling the repository", async () => {
    const repository = fakeRepository();
    const service = new ChatApplicationService(repository);

    await service.listConversations(actor(), { limit: 999 });
    await service.listMessages(actor(), {
      conversationId: " conversation_1 ",
      cursor: " message_cursor ",
      limit: 999,
    });
    await service.listRunEvents(actor(), { runId: "run_1", afterSequence: 12, limit: 999 });

    expect(repository.listConversations).toHaveBeenCalledWith({ actor: actor(), limit: 100 });
    expect(repository.listMessages).toHaveBeenCalledWith({
      actor: actor(),
      conversationId: "conversation_1",
      cursor: "message_cursor",
      limit: 100,
    });
    expect(repository.listRunEvents).toHaveBeenCalledWith({
      actor: actor(),
      runId: "run_1",
      afterSequence: 12,
      limit: 500,
    });
  });

  it("opts into archived Conversation access only for internal read-model authorization", async () => {
    const repository = fakeRepository();
    repository.getConversation.mockResolvedValue({
      id: "conversation_1",
      title: "Archived Chat",
      engine: "opencompany",
      model: "openai/gpt-5.5",
      runtime: null,
      activityState: "idle",
      hasUnseen: false,
      pinnedAt: null,
      createdAt: new Date("2026-08-11T15:00:00.000Z"),
      updatedAt: new Date("2026-08-11T15:10:00.000Z"),
    });
    const service = new ChatApplicationService(repository);

    await service.getConversation(actor(), " conversation_1 ");
    await service.getConversation(actor(), " conversation_1 ", { includeArchived: true });

    expect(repository.getConversation).toHaveBeenNthCalledWith(1, {
      actor: actor(),
      conversationId: "conversation_1",
    });
    expect(repository.getConversation).toHaveBeenNthCalledWith(2, {
      actor: actor(),
      conversationId: "conversation_1",
      includeArchived: true,
    });
  });

  it("normalizes opaque attachment references without accepting provider locators", async () => {
    const repository = fakeRepository();
    const service = new ChatApplicationService(repository);

    await service.createMessage(actor(), command({ attachmentIds: [" upload_1 "] }));

    expect(repository.createMessageAndRun).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ attachmentIds: ["upload_1"] }),
      }),
    );
  });

  it("accepts attachment-only Messages and rejects duplicate references", async () => {
    const repository = fakeRepository();
    const service = new ChatApplicationService(repository);

    await expect(
      service.createMessage(actor(), command({ content: " ", attachmentIds: ["upload_1"] })),
    ).resolves.toMatchObject({ runId: "run_1" });
    expect(() =>
      service.createMessage(
        actor(),
        command({ content: "Attachment", attachmentIds: ["upload_1", "upload_1"] }),
      ),
    ).toThrow(/unique/i);
  });

  it("normalizes skill mentions and rejects duplicate protocol references", async () => {
    const repository = fakeRepository();
    const service = new ChatApplicationService(repository);

    await service.createMessage(actor(), command({ mentions: [{ kind: "skill", id: " sales " }] }));
    expect(repository.createMessageAndRun).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ mentions: [{ kind: "skill", id: "sales" }] }),
      }),
    );
    expect(() =>
      service.createMessage(
        actor(),
        command({
          mentions: [
            { kind: "skill", id: "sales" },
            { kind: "skill", id: "sales" },
          ],
        }),
      ),
    ).toThrow(/unique/i);
  });

  it("keeps Conversation writes actor-scoped and rejects empty updates", async () => {
    const repository = fakeRepository();
    const service = new ChatApplicationService(repository);

    await expect(
      service.updateConversation(actor(), " conversation_1 ", { pinned: true }),
    ).resolves.toEqual({ conversationId: "conversation_1", transactionId: "43" });
    expect(repository.updateConversation).toHaveBeenCalledWith({
      actor: actor(),
      conversationId: "conversation_1",
      command: { pinned: true },
    });
    await expect(service.updateConversation(actor(), "conversation_1", {})).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      service.updateConversation(actor({ permissions: [CHAT_READ_PERMISSION] }), "conversation_1", {
        markSeen: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps cancellation and approval authorization in the application core", async () => {
    const repository = fakeRepository();
    const service = new ChatApplicationService(repository);

    await expect(service.cancelRun(actor(), " run_1 ")).resolves.toMatchObject({
      status: "canceled",
    });
    await expect(
      service.resolveApproval(actor(), {
        runId: " run_1 ",
        approvalId: " approval_1 ",
        resolution: "answered",
        answer: " Use the conservative option. ",
      }),
    ).resolves.toMatchObject({ resolution: "answered" });

    expect(repository.cancelRun).toHaveBeenCalledWith({ actor: actor(), runId: "run_1" });
    expect(repository.resolveApproval).toHaveBeenCalledWith({
      actor: actor(),
      command: {
        runId: "run_1",
        approvalId: "approval_1",
        resolution: "answered",
        answer: "Use the conservative option.",
      },
    });
    await expect(
      service.resolveApproval(actor(), {
        runId: "run_1",
        approvalId: "approval_question_1",
        resolution: "answered",
        answer: {
          type: "engine_questions",
          schemaVersion: 1,
          answers: { question_1: { answers: [" Use Postgres. "] } },
        },
      }),
    ).resolves.toMatchObject({ resolution: "answered" });
    expect(repository.resolveApproval).toHaveBeenLastCalledWith({
      actor: actor(),
      command: {
        runId: "run_1",
        approvalId: "approval_question_1",
        resolution: "answered",
        answer: {
          type: "engine_questions",
          schemaVersion: 1,
          answers: { question_1: { answers: [" Use Postgres. "] } },
        },
      },
    });
    await expect(
      service.resolveApproval(actor(), {
        runId: "run_1",
        approvalId: "approval_1",
        resolution: "approved",
        answer: "This must not be silently ignored.",
      }),
    ).rejects.toThrow(/only valid/i);

    await expect(
      service.resolveApproval(actor(), {
        runId: "run_1",
        approvalId: "approval_1",
        resolution: "approved",
        answer: "unexpected",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      service.resolveApproval(actor(), {
        runId: "run_1",
        approvalId: "approval_1",
        resolution: "answered",
        answer: "x".repeat(10_001),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [CHAT_READ_PERMISSION, CHAT_WRITE_PERMISSION],
    authenticationMethod: "session",
    ...overrides,
  };
}

function command(overrides: Partial<CreateMessageCommand> = {}): CreateMessageCommand {
  return {
    idempotencyKey: "send-1",
    content: "Hello",
    engine: "opencompany",
    model: "openai/gpt-5.5",
    ...overrides,
  };
}

function fakeRepository(): ChatRepository & {
  createMessageAndRun: ReturnType<typeof vi.fn>;
  getConversation: ReturnType<typeof vi.fn>;
  listConversations: ReturnType<typeof vi.fn>;
  listRunEvents: ReturnType<typeof vi.fn>;
} {
  return {
    listConversations: vi.fn(async () => ({ conversations: [], nextCursor: null })),
    getConversation: vi.fn(async () => null),
    listMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
    createMessageAndRun: vi.fn(async () => ({
      conversationId: "conversation_1",
      messageId: "message_1",
      assistantMessageId: "message_2",
      runId: "run_1",
      transactionId: "42",
      idempotentReplay: false,
    })),
    updateConversation: vi.fn(async ({ conversationId }) => ({
      conversationId,
      transactionId: "43",
    })),
    getRun: vi.fn(async () => null),
    listRunEvents: vi.fn(async () => ({ events: [], nextSequence: 12 })),
    cancelRun: vi.fn(async () => ({
      runId: "run_1",
      status: "canceled" as const,
      idempotentReplay: false,
    })),
    resolveApproval: vi.fn(async () => ({
      approvalId: "approval_1",
      runId: "run_1",
      resolution: "answered" as const,
      idempotentReplay: false,
    })),
  };
}
