import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeGoatPublishArtifactDynamicTool,
  publishGoatChatArtifact,
} from "./goat-chat-artifacts";
import type { SandboxHandle } from "./sandbox";

const blobMocks = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn() }));
const dbMocks = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }));

vi.mock("@vercel/blob", () => ({ put: blobMocks.put, del: blobMocks.del }));
vi.mock("./db", () => ({ getDb: () => dbMocks }));

function sandbox() {
  return {
    commands: {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: "/home/user/opencompany-goat/codex-chat/report.md\n",
      })),
    },
    files: {
      getInfo: vi.fn(async () => ({ type: "file", size: 8 })),
      read: vi.fn(async () => new TextEncoder().encode("# Report")),
    },
  };
}

function context(sandboxValue = sandbox()) {
  return {
    sandbox: sandboxValue as unknown as SandboxHandle,
    workDirectory: "/home/user/opencompany-goat/codex-chat",
    workspaceId: "workspace_1",
    userWorkosId: "user_1",
    chatSessionId: "chat_1",
    codexChatSessionId: "codex_session_1",
    turnId: "turn_1",
    assistantMessageId: "assistant_1",
    engine: "codex" as const,
    env: { blobReadWriteToken: "blob_token" },
    checkAbort: vi.fn(async () => undefined),
  };
}

describe("publishGoatChatArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.execute.mockReset();
    blobMocks.put.mockReset();
    blobMocks.del.mockReset();
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: "persisted_version" }] });
    dbMocks.select.mockReset().mockReturnValue({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
    });
    blobMocks.put.mockResolvedValue({ pathname: "private/artifact/report.md" });
    blobMocks.del.mockResolvedValue(undefined);
  });

  it("promotes an allowed sandbox file into a private immutable version", async () => {
    const sandboxValue = sandbox();
    const result = await publishGoatChatArtifact({
      context: context(sandboxValue),
      input: { path: "report.md", title: "Quarterly report" },
      toolCallId: "call_1",
    });

    expect(result).toMatchObject({
      ok: true,
      artifact: {
        version: 1,
        title: "Quarterly report",
        filename: "report.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        state: "ready",
      },
    });
    expect(blobMocks.put).toHaveBeenCalledWith(
      expect.stringMatching(/^goat-chat-artifacts\/workspace_1\/goat_chat_artifact_/),
      expect.any(Buffer),
      expect.objectContaining({
        access: "private",
        addRandomSuffix: false,
        contentType: "text/markdown",
        token: "blob_token",
      }),
    );
    expect(sandboxValue.files.read).toHaveBeenCalledWith(
      "/home/user/opencompany-goat/codex-chat/report.md",
      { format: "bytes" },
    );
  });

  it("returns the same immutable version when a host tool call is retried", async () => {
    dbMocks.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                artifact: {
                  id: "artifact_1",
                  title: "Quarterly report",
                  description: null,
                  archivedAt: null,
                },
                version: {
                  id: "version_1",
                  version: 1,
                  title: "Quarterly report",
                  description: null,
                  filename: "report.md",
                  mediaType: "text/markdown",
                  sizeBytes: 8,
                },
              },
            ],
          }),
        }),
      }),
    });
    const sandboxValue = sandbox();
    const result = await publishGoatChatArtifact({
      context: context(sandboxValue),
      input: { path: "report.md" },
      toolCallId: "call_1",
    });

    expect(result).toMatchObject({
      ok: true,
      artifact: { artifactId: "artifact_1", artifactVersionId: "version_1" },
    });
    expect(dbMocks.execute).not.toHaveBeenCalled();
    expect(sandboxValue.commands.run).not.toHaveBeenCalled();
    expect(blobMocks.put).not.toHaveBeenCalled();
  });

  it("rejects paths outside the engine working directory before reading bytes", async () => {
    const sandboxValue = sandbox();
    await expect(
      publishGoatChatArtifact({
        context: context(sandboxValue),
        input: { path: "../../private.txt" },
        toolCallId: "call_1",
      }),
    ).rejects.toThrow("inside the current chat working directory");

    expect(sandboxValue.commands.run).not.toHaveBeenCalled();
    expect(blobMocks.put).not.toHaveBeenCalled();
  });

  it("rejects binary content that does not match its extension", async () => {
    const sandboxValue = sandbox();
    sandboxValue.commands.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "/home/user/opencompany-goat/codex-chat/report.pdf\n",
    });
    await expect(
      publishGoatChatArtifact({
        context: context(sandboxValue),
        input: { path: "report.pdf" },
        toolCallId: "call_1",
      }),
    ).rejects.toThrow("contents do not match");
    expect(blobMocks.put).not.toHaveBeenCalled();
  });

  it("enforces the per-turn publication limit before sandbox I/O", async () => {
    vi.clearAllMocks();
    dbMocks.execute.mockReset().mockResolvedValueOnce({ rows: [{ count: 5 }] });
    const sandboxValue = sandbox();
    await expect(
      publishGoatChatArtifact({
        context: context(sandboxValue),
        input: { path: "report.md" },
        toolCallId: "call_1",
      }),
    ).rejects.toThrow("already published 5 files");
    expect(sandboxValue.commands.run).not.toHaveBeenCalled();
  });

  it("returns a model-visible tool error for malformed input", async () => {
    const result = await executeGoatPublishArtifactDynamicTool({
      context: context(),
      call: {
        threadId: "thread_1",
        turnId: "turn_1",
        callId: "call_1",
        namespace: null,
        tool: "publish_artifact",
        arguments: {},
      },
    });
    expect(result.success).toBe(false);
    expect(result.contentItems[0]).toMatchObject({ type: "inputText" });
    expect(JSON.parse((result.contentItems[0] as { text: string }).text)).toEqual({
      ok: false,
      error: "path is required.",
    });
  });
});
