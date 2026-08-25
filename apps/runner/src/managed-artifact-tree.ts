import { createHash } from "node:crypto";
import path from "node:path";
import { shellQuote } from "@opencompany/agent-runtime";
import { type SandboxHandle, writeSandboxTextFiles } from "./sandbox";

const SANDBOX_ROOT_USER = "root";

export type ManagedArtifactFile = {
  path: string;
  content: Uint8Array;
  executable: boolean;
};

export async function reconcileManagedArtifactTree(input: {
  sandbox: SandboxHandle;
  root: string;
  manifestName: string;
  manifestKey: string;
  ids: string[];
  files: ManagedArtifactFile[];
  isSafeId: (id: string) => boolean;
}) {
  assertAbsoluteNormalizedPath(input.root);
  const manifestPath = `${input.root}/${input.manifestName}`;
  const previousIds = await readManagedIds({ ...input, manifestPath });
  const resetIds = [...new Set([...previousIds, ...input.ids])];
  const verify = verifyManagedPathCommand(input.root);
  await input.sandbox.commands.run(
    [
      verify,
      `mkdir -p ${shellQuote(input.root)}`,
      verifyManagedPathCommand(input.root, true),
      `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(input.root)}`,
      `chmod 755 ${shellQuote(input.root)}`,
      ...resetIds.map((id) => `rm -rf ${shellQuote(`${input.root}/${id}`)}`),
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );

  await input.sandbox.commands.run(verifyManagedPathCommand(input.root, true), {
    user: SANDBOX_ROOT_USER,
    timeoutMs: 30_000,
  });
  await writeSandboxTextFiles({
    sandbox: input.sandbox,
    files: [
      ...input.files.map(({ path: filePath, content }) => ({ path: filePath, content })),
      {
        path: manifestPath,
        content: JSON.stringify({ version: 1, [input.manifestKey]: input.ids }, null, 2),
      },
    ],
    user: SANDBOX_ROOT_USER,
  });

  const managedPaths = input.ids.map((id) => shellQuote(`${input.root}/${id}`));
  const executablePaths = input.files
    .filter((file) => file.executable)
    .map((file) => shellQuote(file.path));
  await input.sandbox.commands.run(
    [
      verifyManagedPathCommand(input.root, true),
      `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(manifestPath)}`,
      `chmod 444 ${shellQuote(manifestPath)}`,
      ...(managedPaths.length > 0
        ? [
            `chown -R ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${managedPaths.join(" ")}`,
            `find ${managedPaths.join(" ")} -type d -exec chmod 555 {} +`,
            `find ${managedPaths.join(" ")} -type f -exec chmod 444 {} +`,
          ]
        : []),
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
  for (const chunk of chunkShellArguments(executablePaths)) {
    await input.sandbox.commands.run(
      [verifyManagedPathCommand(input.root, true), `chmod 555 ${chunk.join(" ")}`].join(" && "),
      { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
    );
  }
  await input.sandbox.commands.run(
    [
      verifyManagedPathCommand(input.root, true),
      `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(input.root)}`,
      `chmod 555 ${shellQuote(input.root)}`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
}

export function managedArtifactFingerprint(
  entries: Array<{
    kind: string;
    id: string;
    fields?: string[];
    files: Array<{ path: string; content: Uint8Array; executable: boolean }>;
  }>,
) {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => compareText(left.id, right.id))) {
    hashField(hash, Buffer.from(entry.kind, "utf8"));
    hashField(hash, Buffer.from(entry.id, "utf8"));
    for (const field of entry.fields ?? []) hashField(hash, Buffer.from(field, "utf8"));
    for (const file of [...entry.files].sort((left, right) => compareText(left.path, right.path))) {
      hashField(hash, Buffer.from("file", "utf8"));
      hashField(hash, Buffer.from(file.path, "utf8"));
      hashField(hash, Uint8Array.of(file.executable ? 1 : 0));
      hashField(hash, file.content);
    }
  }
  return hash.digest("hex");
}

export function combineManagedArtifactFingerprints(...fingerprints: string[]) {
  const hash = createHash("sha256");
  for (const fingerprint of fingerprints) hashField(hash, Buffer.from(fingerprint, "utf8"));
  return hash.digest("hex");
}

export function verifyManagedPathCommand(target: string, mustExist = false) {
  assertAbsoluteNormalizedPath(target);
  const parent = path.posix.dirname(target);
  const quotedTarget = shellQuote(target);
  const quotedParent = shellQuote(parent);
  return [
    `test "$(realpath -m -- ${quotedParent})" = ${quotedParent}`,
    `test ! -L ${quotedParent}`,
    ...(mustExist
      ? [`test -d ${quotedTarget}`, `test ! -L ${quotedTarget}`]
      : [
          `if [ -e ${quotedTarget} ] || [ -L ${quotedTarget} ]; then test -d ${quotedTarget} && test ! -L ${quotedTarget} && test "$(realpath -m -- ${quotedTarget})" = ${quotedTarget}; fi`,
        ]),
  ].join(" && ");
}

function assertAbsoluteNormalizedPath(value: string) {
  if (!value.startsWith("/") || path.posix.normalize(value) !== value) {
    throw new Error(`Managed path is not an absolute normalized path: ${value}`);
  }
}

async function readManagedIds(input: {
  sandbox: SandboxHandle;
  manifestPath: string;
  manifestKey: string;
  isSafeId: (id: string) => boolean;
}) {
  try {
    const parsed = JSON.parse(String(await input.sandbox.files.read(input.manifestPath))) as Record<
      string,
      unknown
    >;
    const ids = parsed.version === 1 ? parsed[input.manifestKey] : null;
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === "string" && input.isSafeId(id));
  } catch {
    return [];
  }
}

function hashField(hash: ReturnType<typeof createHash>, bytes: Uint8Array) {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function chunkShellArguments(args: string[], maxCharacters = 24_000) {
  const chunks: string[][] = [];
  let current: string[] = [];
  let characters = 0;
  for (const argument of args) {
    if (current.length > 0 && characters + argument.length + 1 > maxCharacters) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(argument);
    characters += argument.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
