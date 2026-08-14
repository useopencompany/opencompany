import { createHash } from "node:crypto";
import { type Actor, CoreError } from "@opencompany/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";

const dependencyMocks = vi.hoisted(() => ({
  create: vi.fn(),
  replace: vi.fn(),
  getScoped: vi.fn(),
  getById: vi.fn(),
}));

vi.mock("@opencompany/db/brain-files", () => ({
  getBrainFile: dependencyMocks.getScoped,
  getBrainFileById: dependencyMocks.getById,
}));

vi.mock("@opencompany/agent/brain-assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opencompany/agent/brain-assets")>()),
  createBrainAssetForUser: dependencyMocks.create,
  replaceBrainAssetForUser: dependencyMocks.replace,
}));

vi.mock("@opencompany/agent/brain-files", () => ({
  documentViewFromFileRow: (row: AssetRow) => documentView(row),
}));

import { type BrainAssetStorage, createBrainAssetService } from "./brain-assets";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["brain:read", "brain:write"],
  authenticationMethod: "session",
};

describe("BrainAssetService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authorizes, hashes, stores, and durably replays an upload without exposing its locator", async () => {
    const db = new FakeCommandDb();
    const storage = fakeStorage();
    let row: AssetRow | null = null;
    dependencyMocks.getById.mockImplementation(async () => row);
    dependencyMocks.create.mockImplementation(async (input, options) => {
      const documentId = options.documentId as string;
      row = assetRow({
        id: documentId,
        brainRef: input.brainRef,
        folderPath: input.folderPath,
        assetStorageKey: input.blobUrl,
        originalFileName: input.originalFileName,
        mimeType: input.mimeType,
        assetSizeBytes: input.sizeBytes,
        assetContentHash: input.contentSha256,
      });
      return { ok: true, document: documentView(row), quotaPaused: true };
    });
    const authorizeBrainWrite = vi.fn(async (_actor: Actor, brainId: string) => brainId);
    const service = createBrainAssetService({
      db,
      knowledge: { authorizeBrainWrite, authorizeBrainRead: vi.fn() } as never,
      storage,
    });
    const file = new File(["authoritative bytes"], "Plan.pdf", { type: "application/pdf" });

    const created = await service.upload({
      actor,
      brainId: "brain_1",
      folderPath: "Projects",
      idempotencyKey: "asset-upload-1",
      file,
    });
    const replayed = await service.upload({
      actor,
      brainId: "brain_1",
      folderPath: "Projects",
      idempotencyKey: "asset-upload-1",
      file,
    });

    expect(authorizeBrainWrite).toHaveBeenCalledTimes(2);
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(dependencyMocks.create).toHaveBeenCalledTimes(1);
    expect(dependencyMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "brain_1",
        folderPath: "projects",
        contentSha256: createHash("sha256").update("authoritative bytes").digest("hex"),
        blobUrl: "https://blob.example/private-1",
      }),
      expect.objectContaining({ db, documentId: expect.stringMatching(/^goat_brain_doc_/u) }),
    );
    expect(created).toMatchObject({ quotaPaused: true, replayed: false });
    expect(replayed).toMatchObject({ quotaPaused: false, replayed: true });
    expect(JSON.stringify(created)).not.toMatch(/assetStorageKey|blob\.example|blobUrl/iu);
  });

  it("rejects reuse of an upload idempotency key with different bytes before storing", async () => {
    const db = new FakeCommandDb();
    const storage = fakeStorage();
    let row: AssetRow | null = null;
    dependencyMocks.getById.mockImplementation(async () => row);
    dependencyMocks.create.mockImplementation(async (input, options) => {
      row = assetRow({
        id: options.documentId,
        brainRef: input.brainRef,
        folderPath: input.folderPath,
        assetStorageKey: input.blobUrl,
        originalFileName: input.originalFileName,
        mimeType: input.mimeType,
        assetSizeBytes: input.sizeBytes,
        assetContentHash: input.contentSha256,
      });
      return { ok: true, document: documentView(row), quotaPaused: false };
    });
    const service = createBrainAssetService({
      db,
      knowledge: allowKnowledge() as never,
      storage,
    });
    await service.upload({
      actor,
      brainId: "brain_1",
      folderPath: "inbox",
      idempotencyKey: "same-key",
      file: new File(["first"], "first.pdf", { type: "application/pdf" }),
    });

    await expect(
      service.upload({
        actor,
        brainId: "brain_1",
        folderPath: "inbox",
        idempotencyKey: "same-key",
        file: new File(["second"], "second.pdf", { type: "application/pdf" }),
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "idempotency_conflict",
    } satisfies Partial<ApiError>);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it("removes newly stored bytes when upload registration rolls back", async () => {
    const db = new FakeCommandDb();
    const storage = fakeStorage();
    dependencyMocks.getById.mockResolvedValue(null);
    dependencyMocks.create.mockRejectedValue(new Error("Database unavailable."));
    const service = createBrainAssetService({
      db,
      knowledge: allowKnowledge() as never,
      storage,
    });

    await expect(
      service.upload({
        actor,
        brainId: "brain_1",
        folderPath: "inbox",
        idempotencyKey: "upload-rollback",
        file: new File(["private"], "plan.pdf", { type: "application/pdf" }),
      }),
    ).rejects.toThrow("Database unavailable.");
    expect(storage.delete).toHaveBeenCalledWith({ url: "https://blob.example/private-1" });
  });

  it("replaces bytes transactionally, cleans the prior locator after commit, and never reapplies a completed retry", async () => {
    const db = new FakeCommandDb();
    const storage = fakeStorage();
    let row = assetRow({ assetStorageKey: "https://blob.example/old" });
    dependencyMocks.getScoped.mockImplementation(async () => row);
    dependencyMocks.getById.mockImplementation(async () => row);
    dependencyMocks.replace.mockImplementation(async (input, options) => {
      await options.cleanupReplacedBlob(row.assetStorageKey);
      row = assetRow({
        ...row,
        assetStorageKey: input.blobUrl,
        originalFileName: input.originalFileName,
        mimeType: input.mimeType,
        assetSizeBytes: input.sizeBytes,
        assetContentHash: input.contentSha256,
      });
      return { ok: true, document: documentView(row), quotaPaused: false };
    });
    const service = createBrainAssetService({
      db,
      knowledge: allowKnowledge() as never,
      storage,
    });
    const command = {
      actor,
      brainId: "brain_1",
      documentId: "document_1",
      idempotencyKey: "replace-1",
      file: new File(["replacement"], "replacement.pdf", { type: "application/pdf" }),
    };

    const replaced = await service.replace(command);
    row = assetRow({ ...row, assetContentHash: "f".repeat(64) });
    const replayedAfterLaterChange = await service.replace(command);

    expect(replaced.replayed).toBe(false);
    expect(replayedAfterLaterChange.replayed).toBe(true);
    expect(dependencyMocks.replace).toHaveBeenCalledTimes(1);
    expect(dependencyMocks.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAssetContentHash: createHash("sha256").update("first").digest("hex"),
        expectedAssetStorageKey: "https://blob.example/old",
      }),
      expect.any(Object),
    );
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith({ url: "https://blob.example/old" });
  });

  it("refuses to apply an incomplete stale retry after a later replacement", async () => {
    const db = new FakeCommandDb();
    const storage = fakeStorage();
    storage.put.mockRejectedValueOnce(new Error("Blob store unavailable."));
    let row = assetRow();
    dependencyMocks.getScoped.mockImplementation(async () => row);
    const service = createBrainAssetService({
      db,
      knowledge: allowKnowledge() as never,
      storage,
    });
    const command = {
      actor,
      brainId: "brain_1",
      documentId: "document_1",
      idempotencyKey: "replace-stale",
      file: new File(["stale retry"], "stale.pdf", { type: "application/pdf" }),
    };
    await expect(service.replace(command)).rejects.toThrow("Blob store unavailable.");
    row = assetRow({
      originalFileName: "newer.pdf",
      assetStorageKey: "https://blob.example/newer",
      assetContentHash: "f".repeat(64),
      // Deliberately keep the timestamp unchanged: the durable locator-state
      // fence must detect the replacement without relying on clock precision.
      updatedAt: new Date("2026-08-12T09:00:00.000Z"),
    });

    await expect(service.replace(command)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(dependencyMocks.replace).not.toHaveBeenCalled();
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it("removes newly stored bytes but retains the current asset after an optimistic conflict", async () => {
    const db = new FakeCommandDb();
    const storage = fakeStorage();
    const row = assetRow({ assetStorageKey: "https://blob.example/current" });
    dependencyMocks.getScoped.mockResolvedValue(row);
    dependencyMocks.replace.mockResolvedValue({
      ok: false,
      message: "Brain asset changed before its file could be replaced.",
    });
    const service = createBrainAssetService({
      db,
      knowledge: allowKnowledge() as never,
      storage,
    });

    await expect(
      service.replace({
        actor,
        brainId: "brain_1",
        documentId: "document_1",
        idempotencyKey: "replace-conflict",
        file: new File(["replacement"], "plan.pdf", { type: "application/pdf" }),
      }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith({ url: "https://blob.example/private-1" });
    expect(storage.delete).not.toHaveBeenCalledWith({ url: "https://blob.example/current" });
  });

  it("authorizes a document's owning Brain before reading its private blob", async () => {
    const db = new FakeCommandDb();
    const storage = fakeStorage();
    dependencyMocks.getById.mockResolvedValue(assetRow({ brainRef: "brain_other" }));
    const authorizeBrainRead = vi.fn(async () => {
      throw new CoreError("not_found", "Brain not found.");
    });
    const service = createBrainAssetService({
      db,
      knowledge: { authorizeBrainWrite: vi.fn(), authorizeBrainRead } as never,
      storage,
    });

    await expect(service.download({ actor, documentId: "document_1" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(authorizeBrainRead).toHaveBeenCalledWith(actor, "brain_other");
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("streams private bytes only after the owning Brain authorizes the actor", async () => {
    const db = new FakeCommandDb();
    const storage = fakeStorage();
    const row = assetRow({
      brainRef: "brain_authorized",
      assetStorageKey: "https://blob.example/authorized",
    });
    dependencyMocks.getById.mockResolvedValue(row);
    const authorizeBrainRead = vi.fn(async () => undefined);
    const service = createBrainAssetService({
      db,
      knowledge: { authorizeBrainWrite: vi.fn(), authorizeBrainRead } as never,
      storage,
    });

    const download = await service.download({ actor, documentId: row.id });

    expect(authorizeBrainRead).toHaveBeenCalledWith(actor, "brain_authorized");
    expect(storage.get).toHaveBeenCalledWith({ url: "https://blob.example/authorized" });
    expect(await new Response(download.stream).text()).toBe("private");
    expect(download).toMatchObject({
      filename: "plan.pdf",
      mediaType: "application/pdf",
      sizeBytes: 5,
    });
  });
});

type CommandRow = {
  commandId: string;
  userWorkosId: string;
  workspaceId: string;
  idempotencyKey: string;
  requestHash: string;
  operation: string;
  resourceId: string;
  completedAt: Date | null;
  initialStateHash: string | null;
};

class FakeCommandDb {
  private commands = new Map<string, CommandRow>();
  private pendingInsert: CommandRow | null = null;

  transaction<T>(callback: (tx: this) => Promise<T>) {
    return callback(this);
  }

  insert() {
    return {
      values: (
        values: Omit<CommandRow, "completedAt" | "initialStateHash"> & {
          initialStateHash?: string;
        },
      ) => {
        this.pendingInsert = {
          ...values,
          completedAt: null,
          initialStateHash: values.initialStateHash ?? null,
        };
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              const pending = this.pendingInsert;
              if (!pending) return [];
              const key = this.key(pending);
              if (this.commands.has(key)) return [];
              this.commands.set(key, pending);
              return [
                {
                  commandId: pending.commandId,
                  resourceId: pending.resourceId,
                  completedAt: pending.completedAt,
                  initialStateHash: pending.initialStateHash,
                },
              ];
            },
          }),
        };
      },
    };
  }

  select() {
    return {
      from: () => ({
        where: () => ({
          limit: async () => [...this.commands.values()].slice(-1),
        }),
      }),
    };
  }

  update() {
    return {
      set: (values: { completedAt?: Date }) => ({
        where: async () => {
          const row = [...this.commands.values()].at(-1);
          if (row && values.completedAt) row.completedAt = values.completedAt;
        },
      }),
    };
  }

  private key(row: Pick<CommandRow, "userWorkosId" | "workspaceId" | "idempotencyKey">) {
    return `${row.userWorkosId}:${row.workspaceId}:${row.idempotencyKey}`;
  }
}

type AssetRow = {
  id: string;
  brainRef: string;
  brainId: string;
  folderPath: string;
  format: "pdf";
  mimeType: string;
  originalFileName: string;
  assetStorageKey: string;
  assetSizeBytes: number;
  assetContentHash: string;
  updatedAt: Date;
};

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "document_1",
    brainRef: "brain_1",
    brainId: "plan",
    folderPath: "inbox",
    format: "pdf",
    mimeType: "application/pdf",
    originalFileName: "plan.pdf",
    assetStorageKey: "https://blob.example/private",
    assetSizeBytes: 5,
    assetContentHash: createHash("sha256").update("first").digest("hex"),
    updatedAt: new Date("2026-08-12T09:00:00.000Z"),
    ...overrides,
  };
}

function documentView(row: AssetRow) {
  return {
    id: row.id,
    brainId: row.brainId,
    folderPath: row.folderPath,
    path: `${row.folderPath}/${row.brainId}.md`,
    title: "Plan",
    content: "# Plan",
    body: "Plan",
    timeline: [],
    format: row.format,
    mimeType: row.mimeType,
    originalFileName: row.originalFileName,
    assetStorageKey: row.assetStorageKey,
    assetSizeBytes: row.assetSizeBytes,
    relations: [],
    sources: [],
    kind: "page" as const,
    type: "source" as const,
    status: "draft" as const,
    aliases: [],
    contentHash: "a".repeat(64),
    sizeBytes: 6,
    createdByWorkosId: "user_1",
    createdAt: "2026-08-12T10:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
  };
}

function fakeStorage(): BrainAssetStorage & {
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    put: vi.fn(async () => ({ url: "https://blob.example/private-1" })),
    get: vi.fn(async () => ({
      statusCode: 200,
      stream: new Response("private").body as ReadableStream<Uint8Array>,
    })),
    delete: vi.fn(async () => undefined),
  };
}

function allowKnowledge() {
  return {
    authorizeBrainWrite: vi.fn(async (_actor: Actor, brainId: string) => brainId),
    authorizeBrainRead: vi.fn(async () => undefined),
  };
}
