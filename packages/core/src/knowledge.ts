import {
  type Actor,
  actorHasPermission,
  BRAIN_READ_PERMISSION,
  BRAIN_WRITE_PERMISSION,
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

/** A wiki as the client sees it. `access` has two stored states; see @opencompany/db/wikis. */
export type WikiSummary = {
  id: string;
  name: string;
  slug: string;
  instructions: string;
  access: "workspace" | "restricted";
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

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
  /**
   * The wiki the actor means — an explicit id, otherwise the workspace's default
   * wiki — or null when it does not exist *or* the actor cannot reach it. The two
   * are deliberately indistinguishable so a restricted wiki's existence cannot be
   * probed by a non-member.
   */
  resolveWiki(input: {
    actor: Actor;
    wikiId?: string | undefined;
  }): Promise<{ wikiId: string; name: string; slug: string; instructions: string } | null>;
  /** Every wiki in the actor's workspace they may read, default first. */
  listWikis(input: { actor: Actor }): Promise<WikiSummary[]>;
  listWikiPages(input: { actor: Actor; wikiId: string }): Promise<WikiPage[]>;
  createWikiPage(input: {
    actor: Actor;
    wikiId: string;
    idempotencyKey: string;
    clientPageId?: string;
    nodeType: WikiPage["nodeType"];
    parentPath: string | null;
    title: string;
    slug?: string;
  }): Promise<{ page: WikiPage; transactionIds: number[] }>;
  updateWikiPage(input: {
    actor: Actor;
    wikiId: string;
    id: string;
    body?: string;
    kind?: WikiPage["kind"];
    slug?: string;
    title?: string;
  }): Promise<{ page: WikiPage; transactionIds: number[] }>;
  deleteWikiPage(input: {
    actor: Actor;
    wikiId: string;
    id: string;
    recursive: boolean;
  }): Promise<{ deletedPaths: string[]; transactionIds: number[] }>;
  addWikiTimelineEntry(input: {
    actor: Actor;
    wikiId: string;
    idempotencyKey: string;
    clientEntryId?: string;
    id: string;
    text: string;
    at?: Date;
  }): Promise<{ entry: WikiTimelineEntry; transactionId: number }>;
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

  async listWikis(actor: Actor) {
    requirePermission(actor, WIKI_READ_PERMISSION, "Wiki");
    return this.repository.listWikis({ actor });
  }

  async listWikiPages(actor: Actor, wikiId?: string) {
    const resolved = await this.requireWikiAccess(actor, WIKI_READ_PERMISSION, wikiId);
    return this.repository.listWikiPages({ actor, wikiId: resolved });
  }

  /**
   * Gate for the Electric wiki shapes. Returns the resolved wiki id so the read
   * model filters on exactly the wiki that was authorized, never on the actor's
   * workspace.
   */
  async authorizeWikiRead(actor: Actor, wikiId?: string) {
    return this.requireWikiAccess(actor, WIKI_READ_PERMISSION, wikiId);
  }

  async createWikiPage(
    actor: Actor,
    input: {
      wikiId?: string;
      idempotencyKey: string;
      clientPageId?: string;
      nodeType: WikiPage["nodeType"];
      parentPath: string | null;
      title: string;
      slug?: string;
    },
  ) {
    const wikiId = await this.requireWikiAccess(actor, WIKI_WRITE_PERMISSION, input.wikiId);
    return this.repository.createWikiPage({
      actor,
      wikiId,
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

  async updateWikiPage(
    actor: Actor,
    id: string,
    input: {
      wikiId?: string;
      body?: string;
      kind?: WikiPage["kind"];
      slug?: string;
      title?: string;
    },
  ) {
    const wikiId = await this.requireWikiAccess(actor, WIKI_WRITE_PERMISSION, input.wikiId);
    return this.repository.updateWikiPage({
      actor,
      wikiId,
      id: resourceId(id, "id"),
      ...(input.body !== undefined ? { body: boundedRaw(input.body, 1_000_000, "body") } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.slug !== undefined ? { slug: bounded(input.slug, 80, "slug") } : {}),
      ...(input.title !== undefined ? { title: boundedRaw(input.title, 160, "title") } : {}),
    });
  }

  async deleteWikiPage(actor: Actor, input: { wikiId?: string; id: string; recursive?: boolean }) {
    const wikiId = await this.requireWikiAccess(actor, WIKI_WRITE_PERMISSION, input.wikiId);
    return this.repository.deleteWikiPage({
      actor,
      wikiId,
      id: resourceId(input.id, "id"),
      recursive: input.recursive ?? false,
    });
  }

  async addWikiTimelineEntry(
    actor: Actor,
    input: {
      wikiId?: string;
      idempotencyKey: string;
      clientEntryId?: string;
      id: string;
      text: string;
      at?: string;
    },
  ) {
    const wikiId = await this.requireWikiAccess(actor, WIKI_WRITE_PERMISSION, input.wikiId);
    const at = input.at ? new Date(input.at) : undefined;
    if (at && Number.isNaN(at.getTime())) {
      throw new CoreError("invalid_argument", "Timeline date is invalid.");
    }
    return this.repository.addWikiTimelineEntry({
      actor,
      wikiId,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      ...(input.clientEntryId
        ? { clientEntryId: resourceId(input.clientEntryId, "clientEntryId") }
        : {}),
      id: resourceId(input.id, "id"),
      text: bounded(input.text, 20_000, "text"),
      ...(at ? { at } : {}),
    });
  }

  /**
   * The workspace-level Wiki permission plus per-wiki membership. Both gates run
   * for every wiki entry point in this service; a missing or unreachable wiki is
   * reported as not_found so membership cannot be probed.
   */
  private async requireWikiAccess(actor: Actor, permission: string, wikiIdValue?: string) {
    requirePermission(actor, permission, "Wiki");
    const wiki = await this.repository.resolveWiki({
      actor,
      ...(wikiIdValue ? { wikiId: resourceId(wikiIdValue, "wikiId") } : {}),
    });
    if (!wiki) throw new CoreError("not_found", "Wiki not found.");
    return wiki.wikiId;
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
