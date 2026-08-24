import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  checkpoint: vi.fn(),
  get: vi.fn(),
  initialize: vi.fn(),
  release: vi.fn(),
  renew: vi.fn(),
}));

vi.mock("@opencompany/db/plugin-data-runtime-repository", () => ({
  acquireWorkspacePluginDataLease: repositoryMocks.acquire,
  checkpointWorkspacePluginData: repositoryMocks.checkpoint,
  getWorkspacePluginDataRecord: repositoryMocks.get,
  initializeWorkspacePluginDataLease: repositoryMocks.initialize,
  releaseWorkspacePluginDataLease: repositoryMocks.release,
  renewWorkspacePluginDataLease: repositoryMocks.renew,
}));

vi.mock("./db", () => ({ getDb: () => ({}) }));

import type { EnabledPluginRuntime } from "@opencompany/db/plugin-runtime-repository";
import { validatePluginDataArchive } from "./plugin-data-archive";
import { type PluginDataStorage, preparePluginDataRuntime } from "./plugin-data-runtime";

describe("Plugin data runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores data after both the sandbox and installed package are replaced", async () => {
    type StoredLease = {
      workspaceId: string;
      pluginName: string;
      blobPathname: string;
      checksum: string;
      sizeBytes: number;
      generation: number;
      leaseId: string | null;
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
    };
    let record: StoredLease | null = null;
    repositoryMocks.get.mockImplementation(async () => record);
    repositoryMocks.initialize.mockImplementation(async (_db, input) => {
      if (record) return null;
      record = {
        workspaceId: input.workspaceId,
        pluginName: input.pluginName,
        blobPathname: input.blobPathname,
        checksum: input.checksum,
        sizeBytes: input.sizeBytes,
        generation: 0,
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: new Date(Date.now() + input.leaseTtlMs),
      };
      return { ...record };
    });
    repositoryMocks.acquire.mockImplementation(async (_db, input) => {
      if (!record || record.leaseId) return null;
      record = {
        ...record,
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: new Date(Date.now() + input.leaseTtlMs),
      };
      return { ...record };
    });
    repositoryMocks.renew.mockResolvedValue(true);
    repositoryMocks.checkpoint.mockImplementation(async (_db, input) => {
      if (
        !record ||
        record.leaseId !== input.leaseId ||
        record.leaseOwner !== input.leaseOwner ||
        record.generation !== input.expectedGeneration
      ) {
        return null;
      }
      record = {
        ...record,
        blobPathname: input.blobPathname,
        checksum: input.checksum,
        sizeBytes: input.sizeBytes,
        generation: input.expectedGeneration + 1,
        leaseId: input.releaseLease ? null : input.leaseId,
        leaseOwner: input.releaseLease ? null : input.leaseOwner,
        leaseExpiresAt: input.releaseLease ? null : new Date(Date.now() + input.leaseTtlMs),
      };
      return {
        ...record,
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: record.leaseExpiresAt ?? new Date(),
      };
    });
    repositoryMocks.release.mockImplementation(async (_db, input) => {
      if (!record || record.leaseId !== input.leaseId || record.leaseOwner !== input.leaseOwner) {
        return false;
      }
      record = { ...record, leaseId: null, leaseOwner: null, leaseExpiresAt: null };
      return true;
    });

    const blobs = new Map<string, Uint8Array>();
    const storage: PluginDataStorage = {
      upload: vi.fn(async (pathname, bytes) => {
        blobs.set(pathname, Uint8Array.from(bytes));
        return { pathname };
      }),
      download: vi.fn(async (pathname) => {
        const bytes = blobs.get(pathname);
        if (!bytes) throw new Error("missing test blob");
        return Uint8Array.from(bytes);
      }),
      delete: vi.fn(async (pathname) => {
        blobs.delete(pathname);
      }),
    };
    const writtenArchive = tarFile("state.txt", new TextEncoder().encode("durable value"));
    const firstSandbox = fakeSandbox(writtenArchive);
    const firstPackage = mcpPlugin("plugin_v1", "a");
    const firstRuntime = await preparePluginDataRuntime({
      sandbox: firstSandbox.sandbox as never,
      workRoot: "/workspace",
      workspaceId: "workspace_1",
      leaseOwner: "coding-session:first",
      mcpPlugins: [firstPackage],
      checkAbort: async () => undefined,
      storage,
    });
    await firstRuntime.checkpoint({ releaseLease: true });

    expect(record).toMatchObject({
      pluginName: "quality-tools",
      generation: 1,
      leaseId: null,
    });
    expect(validatePluginDataArchive(blobs.get(record!.blobPathname)!)).toEqual([
      { path: "state.txt", type: "file", sizeBytes: 13 },
    ]);

    const replacementSandbox = fakeSandbox(writtenArchive);
    const replacementPackage = mcpPlugin("plugin_v2", "b");
    const replacementRuntime = await preparePluginDataRuntime({
      sandbox: replacementSandbox.sandbox as never,
      workRoot: "/workspace",
      workspaceId: "workspace_1",
      leaseOwner: "coding-session:replacement",
      mcpPlugins: [replacementPackage],
      checkAbort: async () => undefined,
      storage,
    });

    expect(firstPackage.id).not.toBe(replacementPackage.id);
    expect(firstPackage.integrity).not.toBe(replacementPackage.integrity);
    expect(storage.download).toHaveBeenLastCalledWith(record!.blobPathname);
    expect(replacementSandbox.restoredArchives).toEqual([
      expect.objectContaining({ bytes: writtenArchive }),
    ]);
    expect(replacementRuntime.dataRoots.get("quality-tools")).toBe(
      "/workspace/.opencompany/plugin-data/quality-tools",
    );
    await replacementRuntime.release();
  });

  it("renews every lease during a checkpoint that exceeds the lease TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const initialChecksum = `sha256:${"a".repeat(64)}`;
    const records = new Map<
      string,
      {
        workspaceId: string;
        pluginName: string;
        blobPathname: string;
        checksum: string;
        sizeBytes: number;
        generation: number;
        leaseId: string;
        leaseOwner: string;
        leaseExpiresAt: Date;
      }
    >();
    repositoryMocks.acquire.mockImplementation(async (_db, input) => {
      const record = {
        workspaceId: input.workspaceId,
        pluginName: input.pluginName,
        blobPathname: `initial/${input.pluginName}.tar`,
        checksum: initialChecksum,
        sizeBytes: 0,
        generation: 0,
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: new Date(Date.now() + input.leaseTtlMs),
      };
      records.set(input.pluginName, record);
      return { ...record };
    });
    repositoryMocks.renew.mockImplementation(async (_db, input) => {
      const record = records.get(input.pluginName);
      if (!record || record.leaseId !== input.leaseId || record.leaseOwner !== input.leaseOwner) {
        return false;
      }
      record.leaseExpiresAt = new Date(Date.now() + input.leaseTtlMs);
      return true;
    });
    repositoryMocks.checkpoint.mockImplementation(async (_db, input) => {
      const record = records.get(input.pluginName);
      if (
        !record ||
        record.leaseId !== input.leaseId ||
        record.leaseOwner !== input.leaseOwner ||
        record.generation !== input.expectedGeneration ||
        record.leaseExpiresAt.getTime() < Date.now()
      ) {
        return null;
      }
      const checkpoint = {
        ...record,
        blobPathname: input.blobPathname,
        checksum: input.checksum,
        sizeBytes: input.sizeBytes,
        generation: input.expectedGeneration + 1,
        leaseExpiresAt: new Date(Date.now() + input.leaseTtlMs),
      };
      records.set(input.pluginName, checkpoint);
      return { ...checkpoint };
    });
    repositoryMocks.release.mockResolvedValue(true);

    const checkpointArchive = tarFile("state.txt", new TextEncoder().encode("checkpoint"));
    const sandbox = fakeSandbox(checkpointArchive, {
      generation: 0,
      checksum: initialChecksum,
    });
    const storage: PluginDataStorage = {
      upload: vi.fn(async (pathname) => {
        await new Promise((resolve) => setTimeout(resolve, 70_000));
        return { pathname };
      }),
      download: vi.fn(async () => {
        throw new Error("matching sandbox state should not be restored");
      }),
      delete: vi.fn(async () => undefined),
    };
    const runtime = await preparePluginDataRuntime({
      sandbox: sandbox.sandbox as never,
      workRoot: "/workspace",
      workspaceId: "workspace_1",
      leaseOwner: "coding-session:slow-checkpoint",
      mcpPlugins: [mcpPlugin("plugin_a", "a", "alpha"), mcpPlugin("plugin_b", "b", "beta")],
      checkAbort: async () => undefined,
      storage,
    });

    const startedAt = Date.now();
    const checkpoint = runtime.checkpoint({ releaseLease: true });
    await vi.advanceTimersByTimeAsync(140_000);
    await expect(checkpoint).resolves.toBeUndefined();

    expect(Date.now() - startedAt).toBeGreaterThan(60_000);
    expect(repositoryMocks.checkpoint).toHaveBeenCalledTimes(2);
    expect(repositoryMocks.renew).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pluginName: "alpha" }),
    );
    expect(repositoryMocks.renew).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pluginName: "beta" }),
    );
    await expect(runtime.checkpoint({ releaseLease: true })).rejects.toThrow(
      "Plugin data runtime checkpoint has already started.",
    );
  });
});

function mcpPlugin(id: string, integrityCharacter: string, name = "quality-tools") {
  return {
    id,
    name,
    integrity: `sha256:${integrityCharacter.repeat(64)}`,
    stdioServers: [{ name: "local", type: "stdio", command: "node", args: [], env: {} }],
  } satisfies EnabledPluginRuntime["mcpPlugins"][number];
}

function fakeSandbox(
  checkpointArchive: Uint8Array,
  restoredState?: { generation: number; checksum: string },
) {
  const files = new Map<string, string | ArrayBuffer>();
  const restoredArchives: Array<{ path: string; bytes: Uint8Array }> = [];
  return {
    restoredArchives,
    sandbox: {
      commands: {
        run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      },
      files: {
        read: vi.fn(async (path: string, options?: { format?: string }) => {
          if (path.includes("plugin-data-checkpoint-") && options?.format === "bytes") {
            return Uint8Array.from(checkpointArchive).buffer;
          }
          if (path.includes("/.state-") && restoredState) {
            return JSON.stringify(restoredState);
          }
          const value = files.get(path);
          if (value === undefined) throw new Error("missing test sandbox file");
          return value;
        }),
        write: vi.fn(async (pathOrFiles: unknown, contentOrOptions?: unknown) => {
          if (Array.isArray(pathOrFiles)) {
            for (const file of pathOrFiles as Array<{ path: string; data: string | ArrayBuffer }>) {
              files.set(file.path, file.data);
            }
            return;
          }
          const path = String(pathOrFiles);
          const content = contentOrOptions as string | ArrayBuffer;
          files.set(path, content);
          if (path.includes("plugin-data-restore-") && content instanceof ArrayBuffer) {
            restoredArchives.push({ path, bytes: new Uint8Array(content) });
          }
        }),
      },
    },
  };
}

function tarFile(path: string, content: Uint8Array) {
  const header = new Uint8Array(512);
  writeText(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  writeText(header, 156, 1, "0");
  writeText(header, 257, 6, "ustar");
  writeText(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, 148, 8, checksum);
  const padded = new Uint8Array(Math.ceil(content.byteLength / 512) * 512);
  padded.set(content);
  const result = new Uint8Array(512 + padded.byteLength + 1024);
  result.set(header, 0);
  result.set(padded, 512);
  return result;
}

function writeText(target: Uint8Array, offset: number, length: number, value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error("test tar field overflow");
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const encoded = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  writeText(target, offset, length, `${encoded}\0`);
}
