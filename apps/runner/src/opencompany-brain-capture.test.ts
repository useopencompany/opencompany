import type {
  CodexBrainCaptureGatewayRequest,
  CodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { createBrainCaptureRunner } from "./opencompany-brain-capture";

describe("createBrainCaptureRunner", () => {
  it("forwards canonical attachment ids with durable turn identity", async () => {
    let request: CodexBrainCaptureGatewayRequest | null = null;
    const execute = vi.fn(
      async (input: CodexBrainCaptureGatewayRequest): Promise<CodexBrainCaptureGatewayResponse> => {
        request = input;
        return {
          ok: true,
          status: "captured",
          assets: [{ documentId: "document_1", path: "inbox/file.pdf", title: "file.pdf" }],
        };
      },
    );
    const capture = createBrainCaptureRunner(context(), {
      execute,
    });

    await expect(capture({ attachmentIds: ["attachment_1"] })).resolves.toMatchObject({
      ok: true,
      assets: [{ documentId: "document_1" }],
    });
    expect(request).toEqual({
      codexChatSessionId: "session_1",
      codexChatTurnId: "turn_1",
      attachmentIds: ["attachment_1"],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("captures without calling a web origin", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("web unavailable"));
    const capture = createBrainCaptureRunner(context(), {
      execute: async () => ({
        ok: true,
        status: "captured",
        draftId: "remember-this",
        path: "inbox/remember-this.md",
        title: "Remember this",
      }),
    });

    await expect(capture({ content: "Remember this" })).resolves.toMatchObject({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

function context() {
  return {
    sessionId: "session_1",
    turnId: "turn_1",
    signal: new AbortController().signal,
  };
}
