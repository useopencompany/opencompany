import { createHash, randomUUID } from "node:crypto";
import { PLUGIN_DATA_LIMITS, shellQuote } from "@opencompany/agent-runtime";
import {
  acquireWorkspacePluginDataLease,
  checkpointWorkspacePluginData,
  getWorkspacePluginDataRecord,
  initializeWorkspacePluginDataLease,
  releaseWorkspacePluginDataLease,
  renewWorkspacePluginDataLease,
  type WorkspacePluginDataLease,
} from "@opencompany/db/plugin-data-runtime-repository";
import type { EnabledPluginRuntime } from "@opencompany/db/plugin-runtime-repository";
import { del, get, put } from "@vercel/blob";
import { getDb } from "./db";
import { verifyManagedPathCommand } from "./managed-artifact-tree";
import {
  EMPTY_PLUGIN_DATA_ARCHIVE,
  PLUGIN_DATA_ARCHIVE_SCRIPT,
  PLUGIN_DATA_EXTRACT_SCRIPT,
  validatePluginDataArchive,
} from "./plugin-data-archive";
import { pluginRuntimeUser } from "./plugin-mcp-launcher";
import { type SandboxHandle, writeSandboxTextFiles } from "./sandbox";

const SANDBOX_ROOT_USER = "root";
const PLUGIN_DATA_LEASE_TTL_MS = 60_000;
const PLUGIN_DATA_LEASE_WAIT_MS = 30_000;
const PLUGIN_DATA_LEASE_POLL_MS = 250;

export type PluginDataStorage = {
  upload(pathname: string, bytes: Uint8Array): Promise<{ pathname: string }>;
  download(pathname: string): Promise<Uint8Array>;
  delete(pathname: string): Promise<void>;
};

type LeaseEntry = {
  lease: WorkspacePluginDataLease;
  dataRoot: string;
  statePath: string;
};

export type PluginDataRuntime = {
  dataRoots: ReadonlyMap<string, string>;
  assertHealthy(): void;
  checkpoint(input: { releaseLease: boolean }): Promise<void>;
  release(): Promise<void>;
};

export async function preparePluginDataRuntime(input: {
  sandbox: SandboxHandle;
  workRoot: string;
  workspaceId: string;
  leaseOwner: string;
  mcpPlugins: EnabledPluginRuntime["mcpPlugins"];
  blobToken?: string | undefined;
  checkAbort: () => Promise<void>;
  storage?: PluginDataStorage;
}): Promise<PluginDataRuntime> {
  const storage = input.storage ?? vercelPluginDataStorage(input.blobToken);
  const dataBase = `${input.workRoot}/.opencompany/plugin-data`;
  const toolsRoot = `${input.workRoot}/.opencompany/plugin-data-tools`;
  const archiveScript = `${toolsRoot}/archive.py`;
  const extractScript = `${toolsRoot}/extract.py`;
  await prepareDataRuntimeRoots(input.sandbox, {
    dataBase,
    toolsRoot,
    archiveScript,
    extractScript,
  });

  const entries: LeaseEntry[] = [];
  try {
    for (const plugin of [...input.mcpPlugins].sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      await input.checkAbort();
      const lease = await acquireLease({
        workspaceId: input.workspaceId,
        pluginName: plugin.name,
        leaseOwner: input.leaseOwner,
        storage,
        checkAbort: input.checkAbort,
      });
      const dataRoot = `${dataBase}/${plugin.name}`;
      const statePath = `${dataBase}/.state-${hashId(plugin.name)}.json`;
      const entry = { lease, dataRoot, statePath };
      entries.push(entry);
      const stateMatches = await restoredStateMatches(input.sandbox, entry);
      if (!stateMatches) {
        await restorePluginData({
          sandbox: input.sandbox,
          entry,
          storage,
          archiveScript: extractScript,
        });
      }
    }
  } catch (error) {
    await Promise.allSettled(entries.map((entry) => releaseLease(entry.lease)));
    throw error;
  }

  let heartbeatError: Error | null = null;
  let checkpointing = false;
  const heartbeat = setInterval(() => {
    if (checkpointing || heartbeatError) return;
    void Promise.all(entries.map((entry) => renewLease(entry.lease)))
      .then((renewed) => {
        if (renewed.some((value) => !value)) {
          heartbeatError = new Error("Plugin data lease was lost during the coding turn.");
        }
      })
      .catch(() => {
        heartbeatError = new Error("Plugin data lease renewal failed during the coding turn.");
      });
  }, PLUGIN_DATA_LEASE_TTL_MS / 3);
  heartbeat.unref?.();

  const assertHealthy = () => {
    if (heartbeatError) throw heartbeatError;
  };
  const checkpoint = async ({ releaseLease: shouldRelease }: { releaseLease: boolean }) => {
    checkpointing = true;
    try {
      assertHealthy();
      for (const entry of entries) {
        await checkpointPluginData({
          sandbox: input.sandbox,
          entry,
          storage,
          archiveScript,
          releaseLease: shouldRelease,
        });
      }
      clearInterval(heartbeat);
    } finally {
      checkpointing = false;
    }
  };
  const release = async () => {
    clearInterval(heartbeat);
    await Promise.all(entries.map((entry) => releaseLease(entry.lease)));
  };
  return {
    dataRoots: new Map(entries.map((entry) => [entry.lease.pluginName, entry.dataRoot])),
    assertHealthy,
    checkpoint,
    release,
  };
}

async function acquireLease(input: {
  workspaceId: string;
  pluginName: string;
  leaseOwner: string;
  storage: PluginDataStorage;
  checkAbort: () => Promise<void>;
}) {
  const leaseId = randomUUID();
  const deadline = Date.now() + PLUGIN_DATA_LEASE_WAIT_MS;
  while (true) {
    const lease = await acquireWorkspacePluginDataLease(getDb(), {
      workspaceId: input.workspaceId,
      pluginName: input.pluginName,
      leaseId,
      leaseOwner: input.leaseOwner,
      leaseTtlMs: PLUGIN_DATA_LEASE_TTL_MS,
    });
    if (lease) return lease;

    const existing = await getWorkspacePluginDataRecord(getDb(), input);
    if (!existing) {
      const bytes = EMPTY_PLUGIN_DATA_ARCHIVE;
      const checksum = checksumBytes(bytes);
      const uploaded = await input.storage.upload(
        blobPathname(input.workspaceId, input.pluginName, 0),
        bytes,
      );
      const initialized = await initializeWorkspacePluginDataLease(getDb(), {
        workspaceId: input.workspaceId,
        pluginName: input.pluginName,
        blobPathname: uploaded.pathname,
        checksum,
        sizeBytes: bytes.byteLength,
        leaseId,
        leaseOwner: input.leaseOwner,
        leaseTtlMs: PLUGIN_DATA_LEASE_TTL_MS,
      });
      if (initialized) return initialized;
      await input.storage.delete(uploaded.pathname);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Plugin data for ${JSON.stringify(input.pluginName)} is in use by another coding session.`,
      );
    }
    await input.checkAbort();
    await sleep(PLUGIN_DATA_LEASE_POLL_MS);
  }
}

async function prepareDataRuntimeRoots(
  sandbox: SandboxHandle,
  input: { dataBase: string; toolsRoot: string; archiveScript: string; extractScript: string },
) {
  await sandbox.commands.run(
    [
      verifyManagedPathCommand(input.dataBase),
      `mkdir -p ${shellQuote(input.dataBase)}`,
      verifyManagedPathCommand(input.dataBase, true),
      `chown root:root ${shellQuote(input.dataBase)}`,
      `chmod 755 ${shellQuote(input.dataBase)}`,
      verifyManagedPathCommand(input.toolsRoot),
      `mkdir -p ${shellQuote(input.toolsRoot)}`,
      verifyManagedPathCommand(input.toolsRoot, true),
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
  await sandbox.commands.run(verifyManagedPathCommand(input.toolsRoot, true), {
    user: SANDBOX_ROOT_USER,
    timeoutMs: 30_000,
  });
  await writeSandboxTextFiles({
    sandbox,
    files: [
      { path: input.archiveScript, content: PLUGIN_DATA_ARCHIVE_SCRIPT },
      { path: input.extractScript, content: PLUGIN_DATA_EXTRACT_SCRIPT },
    ],
    user: SANDBOX_ROOT_USER,
  });
  await sandbox.commands.run(
    [
      verifyManagedPathCommand(input.toolsRoot, true),
      `chown -R root:root ${shellQuote(input.toolsRoot)}`,
      `chmod 555 ${shellQuote(input.toolsRoot)} ${shellQuote(input.archiveScript)} ${shellQuote(input.extractScript)}`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
}

async function restoredStateMatches(sandbox: SandboxHandle, entry: LeaseEntry) {
  try {
    const parsed = JSON.parse(String(await sandbox.files.read(entry.statePath))) as {
      generation?: unknown;
      checksum?: unknown;
    };
    if (parsed.generation !== entry.lease.generation || parsed.checksum !== entry.lease.checksum) {
      return false;
    }
    await sandbox.commands.run(verifyManagedPathCommand(entry.dataRoot, true), {
      user: SANDBOX_ROOT_USER,
      timeoutMs: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function restorePluginData(input: {
  sandbox: SandboxHandle;
  entry: LeaseEntry;
  storage: PluginDataStorage;
  archiveScript: string;
}) {
  const bytes = await input.storage.download(input.entry.lease.blobPathname);
  if (bytes.byteLength !== input.entry.lease.sizeBytes) {
    throw new Error(
      `Plugin data restore for ${JSON.stringify(input.entry.lease.pluginName)} has an invalid size.`,
    );
  }
  if (checksumBytes(bytes) !== input.entry.lease.checksum) {
    throw new Error(
      `Plugin data restore for ${JSON.stringify(input.entry.lease.pluginName)} failed checksum verification.`,
    );
  }
  validatePluginDataArchive(bytes);
  const archivePath = `/tmp/opencompany-plugin-data-restore-${input.entry.lease.leaseId}.tar`;
  await input.sandbox.commands.run(
    [
      verifyManagedPathCommand(input.entry.dataRoot),
      `rm -rf ${shellQuote(input.entry.dataRoot)}`,
      `mkdir -p ${shellQuote(input.entry.dataRoot)}`,
      verifyManagedPathCommand(input.entry.dataRoot, true),
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
  await input.sandbox.files.write(archivePath, new Uint8Array(bytes).buffer, {
    user: SANDBOX_ROOT_USER,
  });
  const runtimeUser = pluginRuntimeUser(input.entry.lease.pluginName);
  await input.sandbox.commands.run(
    [
      verifyManagedPathCommand(input.entry.dataRoot, true),
      `{ getent passwd ${shellQuote(runtimeUser)} >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin ${shellQuote(runtimeUser)}; }`,
      `${shellQuote(input.archiveScript)} ${shellQuote(archivePath)} ${shellQuote(input.entry.dataRoot)} ${PLUGIN_DATA_LIMITS.maxTotalBytes}`,
      verifyManagedPathCommand(input.entry.dataRoot, true),
      `chown -R ${shellQuote(runtimeUser)}:${shellQuote(runtimeUser)} ${shellQuote(input.entry.dataRoot)}`,
      `chmod 700 ${shellQuote(input.entry.dataRoot)}`,
      `rm -f ${shellQuote(archivePath)}`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
  await writeState(input.sandbox, input.entry);
}

async function checkpointPluginData(input: {
  sandbox: SandboxHandle;
  entry: LeaseEntry;
  storage: PluginDataStorage;
  archiveScript: string;
  releaseLease: boolean;
}) {
  const archivePath = `/tmp/opencompany-plugin-data-checkpoint-${input.entry.lease.leaseId}.tar`;
  await input.sandbox.commands.run(
    [
      verifyManagedPathCommand(input.entry.dataRoot, true),
      `${shellQuote(input.archiveScript)} ${shellQuote(input.entry.dataRoot)} ${shellQuote(archivePath)} ${PLUGIN_DATA_LIMITS.maxTotalBytes}`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await input.sandbox.files.read(archivePath, { format: "bytes" }));
  } finally {
    await input.sandbox.commands
      .run(`rm -f ${shellQuote(archivePath)}`, { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 })
      .catch(() => undefined);
  }
  validatePluginDataArchive(bytes);
  const checksum = checksumBytes(bytes);
  const uploaded = await input.storage.upload(
    blobPathname(
      input.entry.lease.workspaceId,
      input.entry.lease.pluginName,
      input.entry.lease.generation + 1,
    ),
    bytes,
  );
  const previousPathname = input.entry.lease.blobPathname;
  const checkpoint = await checkpointWorkspacePluginData(getDb(), {
    workspaceId: input.entry.lease.workspaceId,
    pluginName: input.entry.lease.pluginName,
    leaseId: input.entry.lease.leaseId,
    leaseOwner: input.entry.lease.leaseOwner,
    expectedGeneration: input.entry.lease.generation,
    blobPathname: uploaded.pathname,
    checksum,
    sizeBytes: bytes.byteLength,
    releaseLease: input.releaseLease,
    leaseTtlMs: PLUGIN_DATA_LEASE_TTL_MS,
  });
  if (!checkpoint) {
    await input.storage.delete(uploaded.pathname);
    throw new Error(
      `Plugin data checkpoint for ${JSON.stringify(input.entry.lease.pluginName)} lost its generation fence.`,
    );
  }
  input.entry.lease = checkpoint;
  await writeState(input.sandbox, input.entry);
  await input.storage.delete(previousPathname);
}

async function writeState(sandbox: SandboxHandle, entry: LeaseEntry) {
  await sandbox.commands.run(verifyManagedPathCommand(entry.dataRoot, true), {
    user: SANDBOX_ROOT_USER,
    timeoutMs: 30_000,
  });
  await sandbox.files.write(
    entry.statePath,
    JSON.stringify({ generation: entry.lease.generation, checksum: entry.lease.checksum }),
    { user: SANDBOX_ROOT_USER },
  );
  await sandbox.commands.run(
    `chown root:root ${shellQuote(entry.statePath)} && chmod 444 ${shellQuote(entry.statePath)}`,
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
}

function vercelPluginDataStorage(token: string | undefined): PluginDataStorage {
  const tokenOption = token ? { token } : {};
  return {
    upload: async (pathname, bytes) =>
      put(pathname, new Uint8Array(bytes).buffer, {
        access: "private",
        addRandomSuffix: false,
        contentType: "application/x-tar",
        ...tokenOption,
      }),
    download: async (pathname) => {
      const response = await get(pathname, { access: "private", useCache: false, ...tokenOption });
      if (!response || response.statusCode !== 200 || !response.stream) {
        throw new Error("Plugin data restore could not download its private archive.");
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > PLUGIN_DATA_LIMITS.maxTotalBytes) {
          await reader.cancel();
          throw new Error("Plugin data restore archive exceeds the 32 MiB limit.");
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    },
    delete: async (pathname) => {
      await del(pathname, tokenOption);
    },
  };
}

async function renewLease(lease: WorkspacePluginDataLease) {
  return renewWorkspacePluginDataLease(getDb(), {
    workspaceId: lease.workspaceId,
    pluginName: lease.pluginName,
    leaseId: lease.leaseId,
    leaseOwner: lease.leaseOwner,
    leaseTtlMs: PLUGIN_DATA_LEASE_TTL_MS,
  });
}

async function releaseLease(lease: WorkspacePluginDataLease) {
  await releaseWorkspacePluginDataLease(getDb(), {
    workspaceId: lease.workspaceId,
    pluginName: lease.pluginName,
    leaseId: lease.leaseId,
    leaseOwner: lease.leaseOwner,
  });
}

function blobPathname(workspaceId: string, pluginName: string, generation: number) {
  return `plugin-data/${hashId(workspaceId)}/${pluginName}/${generation}-${randomUUID()}.tar`;
}

function checksumBytes(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashId(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
