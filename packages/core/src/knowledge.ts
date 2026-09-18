import {
  type Actor,
  actorHasPermission,
  WIKI_READ_PERMISSION,
  WIKI_WRITE_PERMISSION,
} from "./actor";
import { CoreError } from "./chat";

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
