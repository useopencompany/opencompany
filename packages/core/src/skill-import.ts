import { type Actor, actorHasPermission, SKILL_WRITE_PERMISSION } from "./actor";
import { CoreError } from "./chat";
import type { Skill } from "./knowledge";

export type SkillImportSource = {
  type: "github" | "skills.sh";
  url: string;
  ref: string;
  path: string;
};

export type SkillImportCandidate = {
  path: string;
  name: string;
  description: string;
};

export type ResolvedSkillImport = {
  status: "resolved";
  proposedSlug: string;
  name: string;
  description: string;
  instructions: string;
  source: SkillImportSource;
  resolvedCommit: string;
  integrity: string;
  extraFiles: string[];
};

export type SkillImportPreview =
  | ResolvedSkillImport
  | {
      status: "ambiguous";
      candidates: SkillImportCandidate[];
      source: Pick<SkillImportSource, "type" | "url" | "ref">;
    };

export interface SkillImportResolver {
  resolve(input: { url: string; selectedPath?: string }): Promise<SkillImportPreview>;
}

export interface SkillImportRepository {
  importSkill(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    description: string;
    instructions: string;
    source: SkillImportSource;
    resolvedCommit: string;
    integrity: string;
  }): Promise<{ skill: Skill; idempotentReplay: boolean }>;
}

export class SkillImportApplicationService {
  constructor(
    private readonly repository: SkillImportRepository,
    private readonly resolver: SkillImportResolver,
  ) {}

  async preview(actor: Actor, input: { url: string; selectedPath?: string }) {
    requireSkillWrite(actor);
    return this.resolver.resolve({
      url: bounded(input.url, 2_048, "url"),
      ...(input.selectedPath !== undefined
        ? { selectedPath: boundedRaw(input.selectedPath, 512, "selectedPath") }
        : {}),
    });
  }

  async import(
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
    const resolvedCommit = input.expectedResolvedCommit.trim().toLowerCase();
    const integrity = input.expectedIntegrity.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/u.test(resolvedCommit) || !/^sha256:[0-9a-f]{64}$/u.test(integrity)) {
      throw new CoreError("invalid_argument", "Preview this skill again before importing it.");
    }
    const preview = await this.resolver.resolve({
      url: bounded(input.url, 2_048, "url"),
      ...(input.selectedPath !== undefined
        ? { selectedPath: boundedRaw(input.selectedPath, 512, "selectedPath") }
        : {}),
    });
    if (preview.status === "ambiguous") {
      throw new CoreError("conflict", "Choose a skill from the preview before importing it.");
    }
    if (
      preview.resolvedCommit.toLowerCase() !== resolvedCommit ||
      preview.integrity.toLowerCase() !== integrity
    ) {
      throw new CoreError(
        "conflict",
        "This skill changed since the preview. Preview it again before importing.",
      );
    }
    return this.repository.importSkill({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      name: preview.name,
      description: preview.description,
      instructions: preview.instructions,
      source: preview.source,
      resolvedCommit: preview.resolvedCommit,
      integrity: preview.integrity,
    });
  }
}

function requireSkillWrite(actor: Actor) {
  if (
    !actor.userId.trim() ||
    !actor.workspaceId.trim() ||
    !actorHasPermission(actor, SKILL_WRITE_PERMISSION)
  ) {
    throw new CoreError("forbidden", "The actor is not allowed to edit Skills.");
  }
}

function idempotencyKey(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[^\x21-\x7e]/u.test(normalized)) {
    throw new CoreError("invalid_argument", "A valid Idempotency-Key is required.");
  }
  return normalized;
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
