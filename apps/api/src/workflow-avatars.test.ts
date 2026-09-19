import type { Actor } from "@opencompany/core";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createWorkflowAvatarService, type WorkflowAvatarStorage } from "./workflow-avatars";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["workflow:read", "workflow:write"],
  authenticationMethod: "session",
};

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UUID_ASSET = /^[0-9a-f-]{36}\.(?:png|jpg|webp)$/u;

describe("WorkflowAvatarService", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://my.opencompany.test");
  });

  it("authorizes the workflow, stores the bytes privately, and returns an unguessable public URL", async () => {
    const storage = fakeStorage();
    const authorizeWorkflowWrite = vi.fn(async (_actor: Actor, id: string) => id);
    const service = createWorkflowAvatarService({
      workflows: { authorizeWorkflowWrite },
      storage,
    });

    const result = await service.upload({
      actor,
      workflowId: "workflow_1",
      file: pngFile(),
    });

    expect(authorizeWorkflowWrite).toHaveBeenCalledWith(actor, "workflow_1");
    const [pathname] = [...storage.blobs.keys()];
    expect(pathname).toMatch(/^goat-workflow-avatars\/workflow_1\/[0-9a-f-]{36}\.png$/u);
    expect(storage.blobs.get(pathname ?? "")?.mediaType).toBe("image/png");
    expect(result.avatarUrl).toMatch(
      /^https:\/\/my\.opencompany\.test\/workflow-avatars\/workflow_1\/[0-9a-f-]{36}\.png$/u,
    );
    expect(new URL(result.avatarUrl).pathname.split("/").pop()).toMatch(UUID_ASSET);
  });

  it("normalizes agent photos to a real 512px PNG accepted by native Slack profiles", async () => {
    const storage = fakeStorage();
    const service = createWorkflowAvatarService({
      workflows: { authorizeWorkflowWrite: async (_actor, id) => id },
      storage,
      slackAppIcon: true,
    });
    const original = await sharp({
      create: { width: 80, height: 120, channels: 3, background: "#228877" },
    })
      .jpeg()
      .toBuffer();
    await service.upload({
      actor,
      workflowId: "agent",
      file: new File([new Uint8Array(original)], "photo.jpg", { type: "image/jpeg" }),
    });
    const stored = [...storage.blobs.values()][0]!;
    expect(stored.mediaType).toBe("image/png");
    expect(await sharp(stored.bytes).metadata()).toMatchObject({
      width: 512,
      height: 512,
      format: "png",
    });
  });

  it("never writes bytes for a workflow the actor cannot edit", async () => {
    const storage = fakeStorage();
    const service = createWorkflowAvatarService({
      workflows: {
        authorizeWorkflowWrite: vi.fn(async () => {
          throw new ApiError(403, "forbidden", "nope");
        }),
      },
      storage,
    });

    await expect(
      service.upload({ actor, workflowId: "workflow_1", file: pngFile() }),
    ).rejects.toMatchObject({ status: 403 });
    expect(storage.blobs.size).toBe(0);
  });

  it("rejects a file whose bytes do not match its declared image type", async () => {
    const storage = fakeStorage();
    const service = createWorkflowAvatarService({
      workflows: { authorizeWorkflowWrite: vi.fn(async (_actor: Actor, id: string) => id) },
      storage,
    });

    const disguised = new File(
      [new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0x2f, 0x3e])],
      "x.png",
      {
        type: "image/png",
      },
    );

    await expect(
      service.upload({ actor, workflowId: "workflow_1", file: disguised }),
    ).rejects.toMatchObject({ status: 400 });
    expect(storage.blobs.size).toBe(0);
  });

  it.each([
    ["an unsupported type", new File([new Uint8Array(PNG_HEADER)], "a.gif", { type: "image/gif" })],
    ["an empty file", new File([], "a.png", { type: "image/png" })],
    [
      "a file over 1 MB",
      new File([new Uint8Array([...PNG_HEADER, ...new Uint8Array(1024 * 1024)])], "a.png", {
        type: "image/png",
      }),
    ],
  ])("rejects %s", async (_label, file) => {
    const storage = fakeStorage();
    const service = createWorkflowAvatarService({
      workflows: { authorizeWorkflowWrite: vi.fn(async (_actor: Actor, id: string) => id) },
      storage,
    });

    await expect(service.upload({ actor, workflowId: "workflow_1", file })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(storage.blobs.size).toBe(0);
  });

  it("refuses to mint an avatar URL the workflow update would reject", async () => {
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "http://localhost:3002");
    const storage = fakeStorage();
    const service = createWorkflowAvatarService({
      workflows: { authorizeWorkflowWrite: vi.fn(async (_actor: Actor, id: string) => id) },
      storage,
    });

    await expect(
      service.upload({ actor, workflowId: "workflow_1", file: pngFile() }),
    ).rejects.toMatchObject({ status: 503 });
    expect(storage.blobs.size).toBe(0);
  });

  it("serves stored bytes as an immutable public image", async () => {
    const storage = fakeStorage();
    const service = createWorkflowAvatarService({
      workflows: { authorizeWorkflowWrite: vi.fn(async (_actor: Actor, id: string) => id) },
      storage,
    });
    const { avatarUrl } = await service.upload({
      actor,
      workflowId: "workflow_1",
      file: pngFile(),
    });
    const assetId = new URL(avatarUrl).pathname.split("/").pop() ?? "";

    const asset = await service.download({ workflowId: "workflow_1", assetId });

    expect(asset.mediaType).toBe("image/png");
    expect(asset.cacheControl).toBe("public, max-age=31536000, immutable");
    expect(asset.inline).toBe(true);
    await expect(new Response(asset.stream).bytes()).resolves.toEqual(
      new Uint8Array([...PNG_HEADER, 0x00]),
    );
  });

  it("returns not found instead of leaking whether another workflow holds that asset", async () => {
    const storage = fakeStorage();
    const service = createWorkflowAvatarService({
      workflows: { authorizeWorkflowWrite: vi.fn(async (_actor: Actor, id: string) => id) },
      storage,
    });
    const { avatarUrl } = await service.upload({
      actor,
      workflowId: "workflow_1",
      file: pngFile(),
    });
    const assetId = new URL(avatarUrl).pathname.split("/").pop() ?? "";

    await expect(service.download({ workflowId: "workflow_2", assetId })).rejects.toMatchObject({
      status: 404,
    });
  });
});

function pngFile() {
  return new File([new Uint8Array([...PNG_HEADER, 0x00])], "avatar.png", { type: "image/png" });
}

function fakeStorage(): WorkflowAvatarStorage & {
  blobs: Map<string, { mediaType: string; bytes: Buffer }>;
} {
  const blobs = new Map<string, { mediaType: string; bytes: Buffer }>();
  return {
    blobs,
    async put({ pathname, bytes, mediaType }) {
      blobs.set(pathname, { mediaType, bytes });
    },
    async get({ pathname }) {
      const stored = blobs.get(pathname);
      if (!stored) return null;
      return {
        stream: new Blob([new Uint8Array(stored.bytes)]).stream(),
        sizeBytes: stored.bytes.byteLength,
      };
    },
  };
}
