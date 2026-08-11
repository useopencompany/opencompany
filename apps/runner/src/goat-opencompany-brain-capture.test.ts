import type { GoatCodexBrainCaptureGatewayRequest } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { createGoatOpenCompanyBrainCaptureRunner } from "./goat-opencompany-brain-capture";

describe("createGoatOpenCompanyBrainCaptureRunner", () => {
  it("forwards canonical attachment ids with durable turn identity", async () => {
    let request: GoatCodexBrainCaptureGatewayRequest | null = null;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      request = JSON.parse(String(init?.body)) as GoatCodexBrainCaptureGatewayRequest;
      return Response.json({
        ok: true,
        status: "captured",
        assets: [{ documentId: "document_1", path: "inbox/file.pdf", title: "file.pdf" }],
      });
    });
    const capture = createGoatOpenCompanyBrainCaptureRunner(context(), {
      fetch: fetch as typeof globalThis.fetch,
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
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer runner-secret",
    });
  });

  it("fails closed without an app URL", async () => {
    const capture = createGoatOpenCompanyBrainCaptureRunner({
      ...context(),
      env: { goatAppUrl: undefined, internalToken: "runner-secret" },
    });

    await expect(capture({ content: "Remember this" })).resolves.toEqual({
      ok: false,
      error: "Brain capture is not configured.",
    });
  });
});

function context() {
  return {
    sessionId: "session_1",
    turnId: "turn_1",
    env: { goatAppUrl: "https://app.example.com", internalToken: "runner-secret" },
    signal: new AbortController().signal,
  };
}
