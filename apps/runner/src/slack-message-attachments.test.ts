import type { Actor } from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { materializeSlackImageAttachments } from "./slack-message-attachments";

const actor: Actor = {
  userId: "owner",
  workspaceId: "workspace",
  role: "admin",
  permissions: [],
  authenticationMethod: "service",
};
const file = {
  id: "F1",
  name: "bug.png",
  mediaType: "image/png",
  sizeBytes: 4,
  urlPrivateDownload: "https://files.slack.com/files-pri/T1-F1/bug.png",
};

describe("Slack image attachment materialization", () => {
  it("downloads with the bot token and creates a private chat attachment", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-length": "4", "content-type": "image/png" },
        }),
    );
    const create = vi.fn(async (input) => ({
      id: input.id,
      format: input.format,
      mediaType: input.mediaType,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      expiresAt: input.expiresAt,
    }));
    const store = vi.fn(async ({ pathname }: { pathname: string }) => ({
      pathname,
      url: "https://blob.example.test/private",
    }));

    const attachmentIds = await materializeSlackImageAttachments(
      {
        execute: vi.fn(async () => []) as never,
        actor,
        token: "xoxb-test",
        messageKey: "install:C1:100.001",
        files: [file],
      },
      {
        fetch: fetcher as typeof fetch,
        repository: () => ({ create }),
        store: store as never,
      },
    );

    expect(attachmentIds).toEqual([expect.stringMatching(/^attachment_slack_[a-f0-9]{32}$/)]);
    expect(fetcher).toHaveBeenCalledWith(
      new URL(file.urlPrivateDownload),
      expect.objectContaining({
        headers: { Authorization: "Bearer xoxb-test" },
        redirect: "error",
      }),
    );
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: Buffer.from([1, 2, 3, 4]), mediaType: "image/png" }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        id: attachmentIds[0],
        format: "image",
        filename: "bug.png",
        sizeBytes: 4,
        blobUrl: "https://blob.example.test/private",
      }),
    );
  });

  it("rejects non-Slack download URLs before sending the bot token", async () => {
    const fetcher = vi.fn();
    await expect(
      materializeSlackImageAttachments(
        {
          execute: vi.fn(async () => []) as never,
          actor,
          token: "xoxb-test",
          messageKey: "install:C1:100.001",
          files: [{ ...file, urlPrivateDownload: "https://example.com/bug.png" }],
        },
        {
          fetch: fetcher as typeof fetch,
          repository: () => ({ create: vi.fn() }),
          store: vi.fn(),
        },
      ),
    ).rejects.toThrow("invalid private file URL");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
