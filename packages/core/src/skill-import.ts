import {
  type Actor,
  actorHasPermission,
  SKILL_READ_PERMISSION,
  SKILL_WRITE_PERMISSION,
} from "./actor";
import { CoreError } from "./chat";

export const SKILL_FILE_CHUNK_MAX_BYTES = 64 * 1024;

export type ExternalSkillBundleSource = {
  type: "github" | "skills.sh";
  url: string;
  ref: string;
  path: string;
  resolvedCommit: string;
};

export type SkillBundleSource = ExternalSkillBundleSource | { type: "workspace" };

export type SkillBundleFileInput = {
  path: string;
  content: Uint8Array;
  executable: boolean;
};

export type SkillBundleFileMetadata = {
  path: string;
  executable: boolean;
  sizeBytes: number;
};

export type SkillImportFileMetadata = Pick<SkillBundleFileMetadata, "path" | "sizeBytes">;

export type ResolvedSkillBundle = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  body: string;
  source: SkillBundleSource;
  integrity: string;
  files: SkillBundleFileInput[];
  fileCount: number;
  totalBytes: number;
};

export type ExternalResolvedSkillBundle = Omit<ResolvedSkillBundle, "source"> & {
  source: ExternalSkillBundleSource;
};

export type SkillImportCandidate = {
  path: string;
  name: string;
  description: string;
};

export type SkillImportWarning = {
  code: "source_directory_normalized";
  message: string;
};

export type SkillImportResolution =
  | {
      status: "resolved";
      bundle: ExternalResolvedSkillBundle;
      warnings: SkillImportWarning[];
    }
  | {
      status: "ambiguous";
      candidates: SkillImportCandidate[];
      source: Omit<ExternalSkillBundleSource, "path">;
    };

export type SkillImportPreview =
  | {
      status: "resolved";
      name: string;
      description: string;
      license?: string;
      compatibility?: string;
      metadata?: Record<string, string>;
      allowedTools?: string;
      source: ExternalSkillBundleSource;
      integrity: string;
      files: SkillImportFileMetadata[];
      fileCount: number;
      totalBytes: number;
      warnings: SkillImportWarning[];
    }
  | {
      status: "ambiguous";
      candidates: SkillImportCandidate[];
      source: Omit<ExternalSkillBundleSource, "path">;
    };

export type SkillBundle = {
  id: string;
  integrity: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string> | null;
  allowedTools: string | null;
  body: string;
  source: SkillBundleSource;
  files: SkillBundleFileMetadata[];
  createdAt: Date;
};

export type SkillInstallation = {
  id: string;
  name: string;
  enabled: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  bundle: SkillBundle;
};

export type SkillInstallationListItem = Omit<SkillInstallation, "bundle" | "createdAt"> & {
  bundle: Omit<SkillBundle, "body" | "files">;
};

export type InstalledSkillCatalogItem = {
  id: string;
  name: string;
  description: string;
};

export type SkillBundleFile = SkillBundleFileMetadata & { content: Uint8Array };

export type SkillFileChunk = SkillBundleFileMetadata & {
  offset: number;
  nextOffset: number;
  eof: boolean;
  encoding: "utf8" | "base64";
  content: string;
};

export interface SkillImportResolver {
  resolve(input: { url: string; selectedPath?: string }): Promise<SkillImportResolution>;
}

export type SkillAuthoringInput = {
  name: string;
  description: string;
  instructions: string;
};

export interface SkillBundleAuthor {
  create(input: SkillAuthoringInput): Promise<ResolvedSkillBundle>;
}

export interface SkillBundleRepository {
  install(input: {
    actor: Actor;
    idempotencyKey: string;
    bundle: ResolvedSkillBundle;
  }): Promise<{ installation: SkillInstallation; idempotentReplay: boolean }>;
  replace(input: {
    actor: Actor;
    name: string;
    bundle: ResolvedSkillBundle;
  }): Promise<SkillInstallation>;
  list(input: { actor: Actor }): Promise<SkillInstallationListItem[]>;
  listCatalog(input: { actor: Actor }): Promise<InstalledSkillCatalogItem[]>;
  get(input: { actor: Actor; name: string }): Promise<SkillInstallation | null>;
  readFile(input: { actor: Actor; name: string; path: string }): Promise<SkillBundleFile | null>;
  setEnabled(input: { actor: Actor; name: string; enabled: boolean }): Promise<SkillInstallation>;
  archive(input: { actor: Actor; name: string }): Promise<void>;
}

export class SkillImportApplicationService {
  constructor(
    private readonly repository: SkillBundleRepository,
    private readonly resolver: SkillImportResolver,
    private readonly author: SkillBundleAuthor,
  ) {}

  async create(actor: Actor, input: SkillAuthoringInput & { idempotencyKey: string }) {
    requireSkillWrite(actor);
    const bundle = await this.author.create(authoringInput(input));
    return this.repository.install({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      bundle,
    });
  }

  async update(actor: Actor, nameValue: string, input: Omit<SkillAuthoringInput, "name">) {
    requireSkillWrite(actor);
    const name = resourceName(nameValue);
    const bundle = await this.author.create(authoringInput({ name, ...input }));
    return this.repository.replace({ actor, name, bundle });
  }

  async preview(
    actor: Actor,
    input: { url: string; selectedPath?: string },
  ): Promise<SkillImportPreview> {
    requireSkillWrite(actor);
    const resolution = await this.resolve(input);
    if (resolution.status === "ambiguous") return resolution;
    return publicPreview(resolution.bundle, resolution.warnings);
  }

  async install(
    actor: Actor,
    input: {
      idempotencyKey: string;
      url: string;
      selectedPath?: string;
      expectedResolvedCommit: string;
      expectedIntegrity: string;
    },
  ) {
    requireSkillWrite(actor);
    const bundle = await this.resolveExpected(input);
    return this.repository.install({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      bundle,
    });
  }

  async replace(
    actor: Actor,
    nameValue: string,
    input: {
      url: string;
      selectedPath?: string;
      expectedResolvedCommit: string;
      expectedIntegrity: string;
    },
  ) {
    requireSkillWrite(actor);
    const name = resourceName(nameValue);
    const bundle = await this.resolveExpected(input);
    if (bundle.name !== name) {
      throw new CoreError(
        "conflict",
        `Replacement skill name must remain ${JSON.stringify(name)}. Artifacts are never renamed.`,
      );
    }
    return this.repository.replace({ actor, name, bundle });
  }

  list(actor: Actor) {
    requireSkillRead(actor);
    return this.repository.list({ actor });
  }

  listCatalog(actor: Actor) {
    requireSkillRead(actor);
    return this.repository.listCatalog({ actor });
  }

  async inspect(actor: Actor, nameValue: string) {
    requireSkillRead(actor);
    const installation = await this.repository.get({ actor, name: resourceName(nameValue) });
    if (!installation) throw new CoreError("not_found", "Skill not found.");
    return installation;
  }

  async readFile(
    actor: Actor,
    nameValue: string,
    input: { path: string; offset?: number; maxBytes?: number },
  ) {
    requireSkillRead(actor);
    const path = boundedRaw(input.path, 1_024, "path");
    if (!path) throw new CoreError("invalid_argument", "path is invalid.");
    const file = await this.repository.readFile({
      actor,
      name: resourceName(nameValue),
      path,
    });
    if (!file) throw new CoreError("not_found", "Skill file not found.");
    return createSkillFileChunk(file, input);
  }

  setEnabled(actor: Actor, nameValue: string, enabled: boolean) {
    requireSkillWrite(actor);
    return this.repository.setEnabled({ actor, name: resourceName(nameValue), enabled });
  }

  archive(actor: Actor, nameValue: string) {
    requireSkillWrite(actor);
    return this.repository.archive({ actor, name: resourceName(nameValue) });
  }

  private async resolve(input: { url: string; selectedPath?: string }) {
    return this.resolver.resolve({
      url: bounded(input.url, 2_048, "url"),
      ...(input.selectedPath !== undefined
        ? { selectedPath: boundedRaw(input.selectedPath, 512, "selectedPath") }
        : {}),
    });
  }

  private async resolveExpected(input: {
    url: string;
    selectedPath?: string;
    expectedResolvedCommit: string;
    expectedIntegrity: string;
  }) {
    const expectedCommit = input.expectedResolvedCommit.trim().toLowerCase();
    const expectedIntegrity = input.expectedIntegrity.trim().toLowerCase();
    if (
      !/^[0-9a-f]{40}$/u.test(expectedCommit) ||
      !/^sha256:[0-9a-f]{64}$/u.test(expectedIntegrity)
    ) {
      throw new CoreError("invalid_argument", "Preview this skill again before installing it.");
    }
    const resolution = await this.resolve(input);
    if (resolution.status === "ambiguous") {
      throw new CoreError("conflict", "Choose a skill from the preview before installing it.");
    }
    const bundle = resolution.bundle;
    if (
      bundle.source.resolvedCommit.toLowerCase() !== expectedCommit ||
      bundle.integrity.toLowerCase() !== expectedIntegrity
    ) {
      throw new CoreError(
        "conflict",
        "This skill changed since the preview. Preview it again before installing.",
      );
    }
    return bundle;
  }
}

export function createSkillFileChunk(
  file: SkillBundleFile,
  input: { offset?: number; maxBytes?: number },
): SkillFileChunk {
  const offset = input.offset ?? 0;
  const maxBytes = input.maxBytes ?? SKILL_FILE_CHUNK_MAX_BYTES;
  if (!Number.isInteger(offset) || offset < 0 || offset > file.content.length) {
    throw new CoreError("invalid_argument", "offset is outside the skill file.");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > SKILL_FILE_CHUNK_MAX_BYTES) {
    throw new CoreError(
      "invalid_argument",
      `maxBytes must be between 4 and ${SKILL_FILE_CHUNK_MAX_BYTES}.`,
    );
  }

  const text = decodeUtf8(file.content);
  if (text !== null && !isUtf8Boundary(file.content, offset)) {
    throw new CoreError("invalid_argument", "offset must be on a UTF-8 character boundary.");
  }

  let nextOffset = Math.min(file.content.length, offset + maxBytes);
  if (text !== null) {
    while (nextOffset > offset && !isUtf8Boundary(file.content, nextOffset)) nextOffset -= 1;
  }
  const chunk = file.content.subarray(offset, nextOffset);
  return {
    path: file.path,
    executable: file.executable,
    sizeBytes: file.sizeBytes,
    offset,
    nextOffset,
    eof: nextOffset === file.content.length,
    encoding: text === null ? "base64" : "utf8",
    content:
      text === null
        ? Buffer.from(chunk).toString("base64")
        : new TextDecoder("utf-8", { fatal: true }).decode(chunk),
  };
}

function publicPreview(
  bundle: ExternalResolvedSkillBundle,
  warnings: SkillImportWarning[],
): Extract<SkillImportPreview, { status: "resolved" }> {
  return {
    status: "resolved",
    name: bundle.name,
    description: bundle.description,
    ...(bundle.license !== undefined ? { license: bundle.license } : {}),
    ...(bundle.compatibility !== undefined ? { compatibility: bundle.compatibility } : {}),
    ...(bundle.metadata !== undefined ? { metadata: bundle.metadata } : {}),
    ...(bundle.allowedTools !== undefined ? { allowedTools: bundle.allowedTools } : {}),
    source: bundle.source,
    integrity: bundle.integrity,
    files: bundle.files.map((file) => ({
      path: file.path,
      sizeBytes: file.content.length,
    })),
    fileCount: bundle.fileCount,
    totalBytes: bundle.totalBytes,
    warnings,
  };
}

function decodeUtf8(content: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function isUtf8Boundary(content: Uint8Array, offset: number) {
  return offset === 0 || offset === content.length || ((content[offset] ?? 0) & 0xc0) !== 0x80;
}

function requireSkillRead(actor: Actor) {
  if (
    !actor.userId.trim() ||
    !actor.workspaceId.trim() ||
    !actorHasPermission(actor, SKILL_READ_PERMISSION)
  ) {
    throw new CoreError("forbidden", "The actor is not allowed to read Skills.");
  }
}

function requireSkillWrite(actor: Actor) {
  if (
    !actor.userId.trim() ||
    !actor.workspaceId.trim() ||
    !actorHasPermission(actor, SKILL_WRITE_PERMISSION)
  ) {
    throw new CoreError("forbidden", "The actor is not allowed to manage Skills.");
  }
}

function idempotencyKey(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[^\x21-\x7e]/u.test(normalized)) {
    throw new CoreError("invalid_argument", "A valid Idempotency-Key is required.");
  }
  return normalized;
}

function resourceName(value: string) {
  return bounded(value, 64, "name");
}

function authoringInput(input: SkillAuthoringInput): SkillAuthoringInput {
  return {
    name: resourceName(input.name),
    description: bounded(input.description, 1_024, "description"),
    instructions: bounded(input.instructions, 512 * 1_024, "instructions"),
  };
}

function bounded(value: string, max: number, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}

function boundedRaw(value: string, max: number, field: string) {
  if (value.length > max) throw new CoreError("invalid_argument", `${field} is invalid.`);
  return value;
}
