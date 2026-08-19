import {
  type Actor,
  actorHasPermission,
  BRAIN_READ_PERMISSION,
  BRAIN_WRITE_PERMISSION,
  SKILL_READ_PERMISSION,
  SKILL_WRITE_PERMISSION,
  WIKI_READ_PERMISSION,
  WIKI_WRITE_PERMISSION,
} from "./actor";
import { CoreError } from "./chat";

export type BrainFolder = {
  id: string;
  path: string;
  source: "system" | "custom";
  createdAt: Date;
  updatedAt: Date;
};

export type BrainTimelineEntry = { evidenceId: string; at: string; body: string };
export type BrainRelation = { type: string; to: string };
export type BrainSource = { ref: string; capturedAt?: string; title?: string };
export type BrainDocumentFormat =
  | "markdown"
  | "pdf"
  | "docx"
  | "xlsx"
  | "srt"
  | "csv"
  | "tsv"
  | "json"
  | "text"
  | "image";
export type BrainEntityType =
  | "person"
  | "company"
  | "project"
  | "meeting"
  | "concept"
  | "source"
  | "analysis"
  | "note";
export type BrainKind = "page" | "evidence";
export type BrainStatus = "draft" | "active" | "archived" | "merged";

export type BrainDocument = {
  id: string;
  brainId: string;
  folderPath: string;
  path: string;
  title: string;
  description?: string;
  content: string;
  body: string;
  timeline: BrainTimelineEntry[];
  format: BrainDocumentFormat;
  mimeType: string;
  originalFileName: string | null;
  assetSizeBytes: number | null;
  relations: BrainRelation[];
  sources: BrainSource[];
  kind: BrainKind;
  type: BrainEntityType;
  status: BrainStatus;
  aliases: string[];
  contentHash: string;
  sizeBytes: number;
  createdByActorId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BrainSnapshot = { folders: BrainFolder[]; documents: BrainDocument[] };

export type BrainOverview = {
  windowStartedAt: Date;
  itemsAddedLast7Days: number;
  retrievalsLast7Days: number;
  activeSources: number;
};

export type BrainSourceItem = {
  id: string;
  sourceProvider: string;
  sourceType: string;
  externalId: string;
  title: string | null;
  lastIngestError: string | null;
  createdAt: Date;
};

export type WikiPage = {
  id: string;
  slug: string;
  path: string;
  title: string;
  nodeType: "page" | "folder";
  kind: "person" | "company" | "project" | "research" | "meeting" | "other";
  body: string;
  contentHash: string;
  sizeBytes: number;
  format: string;
  mimeType: string | null;
  originalFileName: string | null;
  assetSizeBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WikiTimelineEntry = {
  id: string;
  pageId: string;
  at: Date;
  text: string;
  createdAt: Date;
};

export type SkillSource = {
  type: "github" | "skills.sh";
  url: string;
  ref: string;
  path: string;
  resolvedCommit: string;
};

export type Skill = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  status: "draft" | "active";
  source: SkillSource | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SkillListItem = Omit<Skill, "instructions" | "createdAt">;
export type SkillCatalogItem = Pick<Skill, "name" | "description"> & { id: string };

export interface KnowledgeRepository {
  assertBrainAccess(input: { actor: Actor; brainId: string }): Promise<void>;
  getBrainSnapshot(input: { actor: Actor; brainId: string }): Promise<BrainSnapshot>;
  getBrainOverview(input: { actor: Actor; brainId: string; now: Date }): Promise<BrainOverview>;
  listBrainSourceItems(input: {
    actor: Actor;
    brainId: string;
    ids: string[];
  }): Promise<BrainSourceItem[]>;
  createBrainDocument(input: {
    actor: Actor;
    brainId: string;
    idempotencyKey: string;
    folderPath: string;
    fileName: string;
  }): Promise<BrainDocument>;
  updateBrainDocument(input: {
    actor: Actor;
    brainId: string;
    documentId: string;
    body: string;
    expectedContentHash?: string;
  }): Promise<BrainDocument>;
  renameBrainDocument(input: {
    actor: Actor;
    brainId: string;
    documentId: string;
    title: string;
  }): Promise<BrainDocument>;
  deleteBrainDocument(input: { actor: Actor; brainId: string; documentId: string }): Promise<void>;
  createBrainFolder(input: { actor: Actor; brainId: string; path: string }): Promise<BrainFolder>;
  renameBrainFolder(input: {
    actor: Actor;
    brainId: string;
    fromPath: string;
    toPath: string;
  }): Promise<{ path: string }>;
  deleteBrainFolder(input: { actor: Actor; brainId: string; path: string }): Promise<void>;
  listWikiPages(input: { actor: Actor }): Promise<WikiPage[]>;
  createWikiPage(input: {
    actor: Actor;
    idempotencyKey: string;
    clientPageId?: string;
    nodeType: WikiPage["nodeType"];
    parentPath: string | null;
    title: string;
    slug?: string;
  }): Promise<{ page: WikiPage; transactionIds: number[] }>;
  updateWikiPage(input: {
    actor: Actor;
    id: string;
    body?: string;
    kind?: WikiPage["kind"];
    title?: string;
  }): Promise<{ page: WikiPage; transactionIds: number[] }>;
  deleteWikiPage(input: {
    actor: Actor;
    id: string;
    recursive: boolean;
  }): Promise<{ deletedPaths: string[]; transactionIds: number[] }>;
  addWikiTimelineEntry(input: {
    actor: Actor;
    idempotencyKey: string;
    clientEntryId?: string;
    id: string;
    text: string;
    at?: Date;
  }): Promise<{ entry: WikiTimelineEntry; transactionId: number }>;
  listSkills(input: { actor: Actor }): Promise<SkillListItem[]>;
  listSkillCatalog(input: { actor: Actor }): Promise<SkillCatalogItem[]>;
  getSkill(input: { actor: Actor; slug: string }): Promise<Skill | null>;
  createSkill(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    description: string;
  }): Promise<Skill>;
  updateSkill(input: {
    actor: Actor;
    slug: string;
    name: string;
    description: string;
    instructions: string;
    status: Skill["status"];
  }): Promise<Skill>;
  archiveSkill(input: { actor: Actor; slug: string }): Promise<void>;
}

export class KnowledgeApplicationService {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getBrainSnapshot(actor: Actor, brainId: string) {
    requirePermission(actor, BRAIN_READ_PERMISSION, "Brain");
    const id = resourceId(brainId, "brainId");
    await this.repository.assertBrainAccess({ actor, brainId: id });
    return this.repository.getBrainSnapshot({ actor, brainId: id });
  }

  async authorizeBrainRead(actor: Actor, brainId: string) {
    requirePermission(actor, BRAIN_READ_PERMISSION, "Brain");
    const id = resourceId(brainId, "brainId");
    await this.repository.assertBrainAccess({ actor, brainId: id });
  }

  async authorizeBrainWrite(actor: Actor, brainId: string) {
    return this.requireBrainWrite(actor, brainId);
  }

  async getBrainOverview(actor: Actor, brainId: string) {
    requirePermission(actor, BRAIN_READ_PERMISSION, "Brain");
    const id = resourceId(brainId, "brainId");
    await this.repository.assertBrainAccess({ actor, brainId: id });
    return this.repository.getBrainOverview({ actor, brainId: id, now: this.now() });
  }

  async listBrainSourceItems(actor: Actor, brainId: string, ids: string[]) {
    requirePermission(actor, BRAIN_READ_PERMISSION, "Brain");
    const authorizedBrainId = resourceId(brainId, "brainId");
    await this.repository.assertBrainAccess({ actor, brainId: authorizedBrainId });
    const sourceItemIds = Array.from(new Set(ids.map((id) => resourceId(id, "sourceItemId"))));
    if (sourceItemIds.length === 0 || sourceItemIds.length > 100) {
      throw new CoreError("invalid_argument", "Between 1 and 100 source item ids are required.");
    }
    return this.repository.listBrainSourceItems({
      actor,
      brainId: authorizedBrainId,
      ids: sourceItemIds,
    });
  }

  async createBrainDocument(
    actor: Actor,
    brainId: string,
    input: { idempotencyKey: string; folderPath: string; fileName: string },
  ) {
    const authorizedBrainId = await this.requireBrainWrite(actor, brainId);
    return this.repository.createBrainDocument({
      actor,
      brainId: authorizedBrainId,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      folderPath: bounded(input.folderPath, 512, "folderPath"),
      fileName: bounded(input.fileName, 160, "fileName"),
    });
  }

  async updateBrainDocument(
    actor: Actor,
    brainId: string,
    documentId: string,
    input: { body: string; expectedContentHash?: string },
  ) {
    const authorizedBrainId = await this.requireBrainWrite(actor, brainId);
    return this.repository.updateBrainDocument({
      actor,
      brainId: authorizedBrainId,
      documentId: resourceId(documentId, "documentId"),
      body: boundedRaw(input.body, 1_000_000, "body"),
      ...(input.expectedContentHash
        ? { expectedContentHash: bounded(input.expectedContentHash, 128, "expectedContentHash") }
        : {}),
    });
  }

  async renameBrainDocument(
    actor: Actor,
    brainId: string,
    documentId: string,
    input: { title: string },
  ) {
    const authorizedBrainId = await this.requireBrainWrite(actor, brainId);
    return this.repository.renameBrainDocument({
      actor,
      brainId: authorizedBrainId,
      documentId: resourceId(documentId, "documentId"),
      title: bounded(input.title, 160, "title"),
    });
  }

  async deleteBrainDocument(actor: Actor, brainId: string, documentId: string) {
    const authorizedBrainId = await this.requireBrainWrite(actor, brainId);
    return this.repository.deleteBrainDocument({
      actor,
      brainId: authorizedBrainId,
      documentId: resourceId(documentId, "documentId"),
    });
  }

  async createBrainFolder(actor: Actor, brainId: string, input: { path: string }) {
    const authorizedBrainId = await this.requireBrainWrite(actor, brainId);
    return this.repository.createBrainFolder({
      actor,
      brainId: authorizedBrainId,
      path: bounded(input.path, 512, "path"),
    });
  }

  async renameBrainFolder(
    actor: Actor,
    brainId: string,
    input: { fromPath: string; toPath: string },
  ) {
    const authorizedBrainId = await this.requireBrainWrite(actor, brainId);
    return this.repository.renameBrainFolder({
      actor,
      brainId: authorizedBrainId,
      fromPath: bounded(input.fromPath, 512, "fromPath"),
      toPath: bounded(input.toPath, 512, "toPath"),
    });
  }

  async deleteBrainFolder(actor: Actor, brainId: string, input: { path: string }) {
    const authorizedBrainId = await this.requireBrainWrite(actor, brainId);
    return this.repository.deleteBrainFolder({
      actor,
      brainId: authorizedBrainId,
      path: bounded(input.path, 512, "path"),
    });
  }

  listWikiPages(actor: Actor) {
    requirePermission(actor, WIKI_READ_PERMISSION, "Wiki");
    return this.repository.listWikiPages({ actor });
  }

  authorizeWikiRead(actor: Actor) {
    requirePermission(actor, WIKI_READ_PERMISSION, "Wiki");
  }

  createWikiPage(
    actor: Actor,
    input: {
      idempotencyKey: string;
      clientPageId?: string;
      nodeType: WikiPage["nodeType"];
      parentPath: string | null;
      title: string;
      slug?: string;
    },
  ) {
    requirePermission(actor, WIKI_WRITE_PERMISSION, "Wiki");
    return this.repository.createWikiPage({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      ...(input.clientPageId
        ? { clientPageId: resourceId(input.clientPageId, "clientPageId") }
        : {}),
      nodeType: input.nodeType,
      parentPath: input.parentPath ? bounded(input.parentPath, 512, "parentPath") : null,
      title: boundedRaw(input.title, 160, "title"),
      ...(input.slug ? { slug: bounded(input.slug, 80, "slug") } : {}),
    });
  }

  updateWikiPage(
    actor: Actor,
    id: string,
    input: {
      body?: string;
      kind?: WikiPage["kind"];
      title?: string;
    },
  ) {
    requirePermission(actor, WIKI_WRITE_PERMISSION, "Wiki");
    return this.repository.updateWikiPage({
      actor,
      id: resourceId(id, "id"),
      ...(input.body !== undefined ? { body: boundedRaw(input.body, 1_000_000, "body") } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.title !== undefined ? { title: boundedRaw(input.title, 160, "title") } : {}),
    });
  }

  deleteWikiPage(actor: Actor, input: { id: string; recursive?: boolean }) {
    requirePermission(actor, WIKI_WRITE_PERMISSION, "Wiki");
    return this.repository.deleteWikiPage({
      actor,
      id: resourceId(input.id, "id"),
      recursive: input.recursive ?? false,
    });
  }

  addWikiTimelineEntry(
    actor: Actor,
    input: {
      idempotencyKey: string;
      clientEntryId?: string;
      id: string;
      text: string;
      at?: string;
    },
  ) {
    requirePermission(actor, WIKI_WRITE_PERMISSION, "Wiki");
    const at = input.at ? new Date(input.at) : undefined;
    if (at && Number.isNaN(at.getTime())) {
      throw new CoreError("invalid_argument", "Timeline date is invalid.");
    }
    return this.repository.addWikiTimelineEntry({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      ...(input.clientEntryId
        ? { clientEntryId: resourceId(input.clientEntryId, "clientEntryId") }
        : {}),
      id: resourceId(input.id, "id"),
      text: bounded(input.text, 20_000, "text"),
      ...(at ? { at } : {}),
    });
  }

  listSkills(actor: Actor) {
    requirePermission(actor, SKILL_READ_PERMISSION, "Skills");
    return this.repository.listSkills({ actor });
  }

  listSkillCatalog(actor: Actor) {
    requirePermission(actor, SKILL_READ_PERMISSION, "Skills");
    return this.repository.listSkillCatalog({ actor });
  }

  async getSkill(actor: Actor, slug: string) {
    requirePermission(actor, SKILL_READ_PERMISSION, "Skills");
    const skill = await this.repository.getSkill({ actor, slug: resourceId(slug, "slug") });
    if (!skill) throw new CoreError("not_found", "Skill not found.");
    return skill;
  }

  createSkill(actor: Actor, input: { idempotencyKey: string; name: string; description?: string }) {
    requirePermission(actor, SKILL_WRITE_PERMISSION, "Skills");
    return this.repository.createSkill({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      name: bounded(input.name, 160, "name"),
      description: boundedRaw(input.description ?? "", 1_024, "description"),
    });
  }

  updateSkill(
    actor: Actor,
    slug: string,
    input: {
      name: string;
      description: string;
      instructions: string;
      status: Skill["status"];
    },
  ) {
    requirePermission(actor, SKILL_WRITE_PERMISSION, "Skills");
    return this.repository.updateSkill({
      actor,
      slug: resourceId(slug, "slug"),
      name: bounded(input.name, 160, "name"),
      description: boundedRaw(input.description, 1_024, "description"),
      instructions: boundedRaw(input.instructions, 256 * 1_024, "instructions"),
      status: input.status,
    });
  }

  archiveSkill(actor: Actor, slug: string) {
    requirePermission(actor, SKILL_WRITE_PERMISSION, "Skills");
    return this.repository.archiveSkill({ actor, slug: resourceId(slug, "slug") });
  }

  private async requireBrainWrite(actor: Actor, brainIdValue: string) {
    requirePermission(actor, BRAIN_WRITE_PERMISSION, "Brain");
    const brainId = resourceId(brainIdValue, "brainId");
    await this.repository.assertBrainAccess({ actor, brainId });
    return brainId;
  }
}

function requirePermission(actor: Actor, permission: string, resource: string) {
  if (!actor.userId.trim() || !actor.workspaceId.trim() || !actorHasPermission(actor, permission)) {
    throw new CoreError("forbidden", `The actor is not allowed to access ${resource}.`);
  }
}

function resourceId(value: string, field: string) {
  return bounded(value, 256, field);
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
