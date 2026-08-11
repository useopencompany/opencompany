import type { GoatCodexBrainCaptureGatewayRequest } from "@opencompany/agent-runtime";
import type { GoatBrainCaptureServiceDependencies } from "@opencompany/goat-agent/application/brain-capture";
import { describe, expect, it, vi } from "vitest";
import { executeGoatCodexBrainCaptureGateway } from "@/lib/codex-brain-capture";

const request: GoatCodexBrainCaptureGatewayRequest = {
  codexChatSessionId: "codex_session_1",
  codexChatTurnId: "codex_turn_1",
  content: "The team approved the launch plan.",
  title: "Launch decision",
};

const context = {
  actorId: "user_1",
  workspaceId: "workspace_1",
  brainRef: "brain_1",
  conversationId: "chat_1",
  messageId: "message_1",
};

describe("executeGoatCodexBrainCaptureGateway", () => {
  it("uses the pinned Brain and the existing capture-first pipeline", async () => {
    const capture = vi.fn<GoatBrainCaptureServiceDependencies["capture"]>(async () => ({
      ok: true as const,
      draftBrainId: "launch-decision",
      path: "inbox/launch-decision.md",
      title: "Launch decision",
      jobId: "job_1",
      enqueued: true,
    }));

    const response = await executeGoatCodexBrainCaptureGateway({
      request,
      dependencies: {
        loadContext: vi.fn(async () => context),
        getBrainAccess: vi.fn(async () => ({ brain: { workspaceId: "workspace_1" } })),
        capture,
      },
    });

    expect(response).toEqual({
      ok: true,
      status: "captured",
      draftId: "launch-decision",
      path: "inbox/launch-decision.md",
      title: "Launch decision",
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "brain_1",
        actorId: "user_1",
        text: "The team approved the launch plan.",
        title: "Launch decision",
        source: expect.objectContaining({
          kind: "chat",
          connectionId: "chat_1",
          itemId: "message_1",
          idempotencyKey: expect.stringMatching(/^codex-save:[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("uses a content-derived key so a recovered call is idempotent", async () => {
    const capture = vi.fn<GoatBrainCaptureServiceDependencies["capture"]>(async () => ({
      ok: true as const,
      draftBrainId: "launch-decision",
      path: "inbox/launch-decision.md",
      title: "Launch decision",
      jobId: "job_1",
      enqueued: false,
      alreadyCaptured: true,
    }));
    const dependencies = {
      loadContext: vi.fn(async () => context),
      getBrainAccess: vi.fn(async () => ({ brain: { workspaceId: "workspace_1" } })),
      capture,
    };

    const first = await executeGoatCodexBrainCaptureGateway({ request, dependencies });
    const recovered = await executeGoatCodexBrainCaptureGateway({
      request,
      dependencies,
    });

    expect(first).toMatchObject({ ok: true, status: "already_captured" });
    expect(recovered).toMatchObject({ ok: true, status: "already_captured" });
    const firstSource = capture.mock.calls[0]?.[0].source;
    const recoveredSource = capture.mock.calls[1]?.[0].source;
    expect(firstSource?.kind).toBe("chat");
    expect(recoveredSource?.kind).toBe("chat");
    if (firstSource?.kind !== "chat" || recoveredSource?.kind !== "chat") {
      throw new Error("Expected Codex captures to use the chat source.");
    }
    expect(firstSource.idempotencyKey).toBe(recoveredSource.idempotencyKey);
  });

  it("resolves the default accessible Brain for an ordinary OpenCompany Chat", async () => {
    const capture = vi.fn<GoatBrainCaptureServiceDependencies["capture"]>(async () => ({
      ok: true,
      draftBrainId: "launch-decision",
      path: "inbox/launch-decision.md",
      title: "Launch decision",
      jobId: "job_1",
      enqueued: true,
    }));

    await executeGoatCodexBrainCaptureGateway({
      request,
      dependencies: {
        loadContext: vi.fn(async () => ({
          ...context,
          brainRef: null,
          allowDefaultBrain: true,
        })),
        listBrains: vi.fn(async () => [
          { id: "brain_other", slug: "other" },
          { id: "brain_default", slug: "general" },
        ]) as never,
        getBrainAccess: vi.fn(async () => ({ brain: { workspaceId: "workspace_1" } })),
        capture,
      },
    });

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ brainRef: "brain_default" }));
  });

  it("files canonical message attachments through the existing Brain asset boundary", async () => {
    const saveAttachments = vi.fn(async () => ({
      ok: true as const,
      status: "captured" as const,
      assets: [{ documentId: "document_1", path: "inbox/file.pdf", title: "file.pdf" }],
    }));
    const loadMessages = vi.fn(async () => [
      { role: "user" as const, attachments: [{ id: "attachment_1" }] as never },
    ]);

    const response = await executeGoatCodexBrainCaptureGateway({
      request: {
        codexChatSessionId: request.codexChatSessionId,
        codexChatTurnId: request.codexChatTurnId,
        attachmentIds: ["attachment_1"],
      },
      dependencies: {
        loadContext: vi.fn(async () => context),
        getBrainAccess: vi.fn(async () => ({ brain: { workspaceId: "workspace_1" } })),
        loadMessages,
        saveAttachments: saveAttachments as never,
      },
    });

    expect(response).toMatchObject({ ok: true, assets: [{ documentId: "document_1" }] });
    expect(loadMessages).toHaveBeenCalledWith("chat_1");
    expect(saveAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "brain_1",
        actorId: "user_1",
        attachmentIds: ["attachment_1"],
      }),
    );
  });

  it("fails closed when the pinned Brain no longer belongs to an accessible workspace", async () => {
    const capture = vi.fn();
    const response = await executeGoatCodexBrainCaptureGateway({
      request,
      dependencies: {
        loadContext: vi.fn(async () => context),
        getBrainAccess: vi.fn(async () => ({ brain: { workspaceId: "another_workspace" } })),
        capture,
      },
    });

    expect(response).toMatchObject({ ok: false, error: expect.stringContaining("access") });
    expect(capture).not.toHaveBeenCalled();
  });
});
