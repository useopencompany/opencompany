// The API-owned application boundary for the `wiki` agent tool. It executes the
// full eleven-command tool contract (WikiToolInput) against a repository port,
// reconstructing the same output shapes the runner/MCP tool used to produce.
//
// This is deliberately separate from KnowledgeApplicationService's browser page
// CRUD: agents drive path-based commands (auto-created ancestors, subtree moves
// with link rewrites, timeline entries) rather than page-id mutations. Every
// caller — the runner over HTTP and the API-hosted MCP tool in-process — funnels
// through here so authorization, validation, and error shaping stay identical.

import {
  firstWikiPageRef,
  isValidWikiKind,
  isWikiDescendantPath,
  resolveWikiSince,
  WIKI_READ_COMMANDS,
  type WikiKind,
  type WikiToolCommand,
  type WikiToolInput,
  type WikiToolOutput,
  wikiPageRefs,
} from "@opencompany/wiki";
import {
  type Actor,
  actorHasPermission,
  WIKI_READ_PERMISSION,
  WIKI_WRITE_PERMISSION,
} from "./actor";
import { CoreError } from "./chat";

const WIKI_TREE_AUTO_DEPTH_THRESHOLD = 40;

// Domain-level failure raised by validation or the repository. Mapped to the
// tool's { ok: false, error } contract — never leaked as an HTTP 5xx. Permission
// failures use CoreError instead, so they surface as 403 at the API boundary.
export class WikiCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiCommandError";
  }
}

// --- Repository port DTOs -----------------------------------------------------
// The Postgres implementation lives in @opencompany/db and delegates to the wiki
// domain functions. These shapes mirror what those functions already return, so
// the mapping stays mechanical.

export type WikiCommandTreeNode = {
  slug: string;
  path: string;
  title: string;
  kind: WikiKind;
  nodeType: "page" | "folder";
  sizeBytes: number;
  updatedAt: Date;
  childCount: number;
};

export type WikiCommandPage = {
  slug: string;
  path: string;
  title: string;
  kind: WikiKind;
  updatedAt: Date;
  content: string;
};

export type WikiCommandGrepMatch = {
  slug: string;
  path: string;
  lineNumber: number;
  line: string;
};

export type WikiCommandSearchHit = {
  slug: string;
  path: string;
  title: string;
  kind: WikiKind;
  snippet: string;
  updatedAt: Date;
};

export type WikiCommandRecentChange = {
  slug: string;
  path: string;
  title: string;
  deleted: boolean;
  writes: number;
  addedLines: number;
  removedLines: number;
  lastChangedAt: Date;
};

export type WikiCommandTimelineItem = { at: Date; text: string };

export type WikiCommandWriteResult = {
  action: "created" | "updated" | "unchanged";
  path: string;
  slug: string;
  title: string;
  createdAncestors: string[];
};

export type WikiCommandFolderResult = {
  action: "created" | "unchanged";
  path: string;
  title: string;
  createdAncestors: string[];
};

export type WikiCommandMoveResult = {
  path: string;
  fromPath: string;
  movedDescendants: number;
  rewrittenReferrers: string[];
};

export type WikiCommandDeleteResult = { deletedPaths: string[] };

export type WikiCommandTimelineAddResult = { at: Date; text: string };

export interface WikiCommandRepository {
  getTree(input: { workspaceId: string }): Promise<WikiCommandTreeNode[]>;
  resolvePages(input: {
    workspaceId: string;
    refs: string[];
  }): Promise<{ pages: WikiCommandPage[]; missing: string[] }>;
  /** Paths of pages linking to `path`. */
  getBacklinks(input: { workspaceId: string; path: string }): Promise<string[]>;
  grep(input: {
    workspaceId: string;
    pattern: string;
    ignoreCase: boolean;
    limit?: number;
  }): Promise<WikiCommandGrepMatch[]>;
  search(input: {
    workspaceId: string;
    text: string;
    limit?: number;
    offset?: number;
  }): Promise<WikiCommandSearchHit[]>;
  recentChanges(input: {
    workspaceId: string;
    since: Date;
    limit?: number;
  }): Promise<WikiCommandRecentChange[]>;
  listTimeline(input: {
    workspaceId: string;
    path: string;
    since?: Date;
  }): Promise<WikiCommandTimelineItem[]>;
  createFolder(input: {
    workspaceId: string;
    actorWorkosId: string;
    idempotencyKey: string;
    path: string;
    title?: string;
  }): Promise<WikiCommandFolderResult>;
  writePage(input: {
    workspaceId: string;
    actorWorkosId: string;
    idempotencyKey: string;
    path: string;
    body: string;
    kind?: WikiKind;
    title?: string;
  }): Promise<WikiCommandWriteResult>;
  moveNode(input: {
    workspaceId: string;
    actorWorkosId: string;
    path: string;
    newParentPath: string | null;
  }): Promise<WikiCommandMoveResult>;
  deletePage(input: {
    workspaceId: string;
    actorWorkosId: string;
    path: string;
    recursive?: boolean;
  }): Promise<WikiCommandDeleteResult>;
  addTimelineEntry(input: {
    workspaceId: string;
    actorWorkosId: string;
    idempotencyKey: string;
    path: string;
    at: Date;
    text: string;
  }): Promise<WikiCommandTimelineAddResult>;
}

export type ExecuteWikiCommandInput = {
  actor: Actor;
  command: WikiToolInput;
  /**
   * Stable per-tool-call identity (e.g. `agent-wiki:<turnId>:<toolCallId>`).
   * Write commands replay against it so a transport retry never duplicates a
   * create or timeline entry.
   */
  idempotencyKey: string;
};

export class WikiCommandApplicationService {
  constructor(private readonly repository: WikiCommandRepository) {}

  async execute(input: ExecuteWikiCommandInput): Promise<WikiToolOutput> {
    const { actor, command, idempotencyKey } = input;
    this.authorize(actor, command.command);
    try {
      const result = await this.dispatch(actor, command, idempotencyKey.trim());
      return { ok: true, result };
    } catch (error) {
      if (error instanceof WikiCommandError) return { ok: false, error: error.message };
      throw error;
    }
  }

  private authorize(actor: Actor, command: WikiToolCommand) {
    const permission = WIKI_READ_COMMANDS.includes(command)
      ? WIKI_READ_PERMISSION
      : WIKI_WRITE_PERMISSION;
    if (
      !actor.userId.trim() ||
      !actor.workspaceId.trim() ||
      !actorHasPermission(actor, permission)
    ) {
      throw new CoreError("forbidden", "The actor is not allowed to access Wiki.");
    }
  }

  private async dispatch(
    actor: Actor,
    toolInput: WikiToolInput,
    idempotencyKey: string,
  ): Promise<unknown> {
    const workspaceId = actor.workspaceId;
    const actorWorkosId = actor.userId;
    if (!idempotencyKey) throw new WikiCommandError("A stable idempotency key is required.");
    switch (toolInput.command) {
      case "tree": {
        const tree = await this.repository.getTree({ workspaceId });
        const automaticDepthLimit =
          toolInput.depth === undefined && tree.length > WIKI_TREE_AUTO_DEPTH_THRESHOLD;
        const depth = toolInput.depth ?? (automaticDepthLimit ? 0 : undefined);
        const visibleTree =
          depth === undefined ? tree : tree.filter((entry) => wikiPathDepth(entry.path) <= depth);
        const truncated = visibleTree.length < tree.length;
        return {
          nodes: visibleTree.map((entry) =>
            entry.nodeType === "folder"
              ? {
                  path: `${entry.path}/`,
                  type: "folder" as const,
                  title: entry.title || entry.slug,
                  children: entry.childCount,
                  updatedAt: entry.updatedAt.toISOString(),
                }
              : {
                  path: entry.path,
                  type: "page" as const,
                  title: entry.title,
                  kind: entry.kind,
                  updatedAt: entry.updatedAt.toISOString(),
                },
          ),
          depth: depth ?? "unlimited",
          shown: visibleTree.length,
          total: tree.length,
          truncated,
          ...(tree.length === 0
            ? { hint: 'The wiki is empty. Create the first page with { command: "write" }.' }
            : truncated
              ? {
                  hint: automaticDepthLimit
                    ? `Showing depth 0 (root entries only) because this wiki has more than ${WIKI_TREE_AUTO_DEPTH_THRESHOLD} entries. Use { command: "tree", depth: 1 } to expand one more level, or read a folder to inspect only its direct children.`
                    : `Showing through depth ${depth}; ${tree.length - visibleTree.length} deeper entries are omitted. Increase depth or read a folder to inspect only its direct children.`,
                }
              : {}),
        };
      }
      case "read": {
        const refs = wikiPageRefs(toolInput);
        if (refs.length === 0) {
          throw new WikiCommandError('read requires "pages" (path(s) or basename(s)).');
        }
        const tree = await this.repository.getTree({ workspaceId });
        const exactFolders = new Map(
          tree
            .filter((entry) => entry.nodeType === "folder")
            .map((entry) => [entry.path, entry] as const),
        );
        const { pages, missing } = await this.repository.resolvePages({
          workspaceId,
          refs: refs.filter((ref) => !exactFolders.has(ref)),
        });
        const resolved = await Promise.all(
          pages.map(async (page) => ({
            slug: page.slug,
            path: page.path,
            title: page.title,
            kind: page.kind,
            updatedAt: page.updatedAt.toISOString(),
            body: page.content,
            backlinks: await this.repository.getBacklinks({ workspaceId, path: page.path }),
          })),
        );
        const resolvedFolderRefs = new Set<string>();
        const folderRefs = refs.filter((ref) => exactFolders.has(ref) || missing.includes(ref));
        const folders = folderRefs.flatMap((ref) => {
          const exact = exactFolders.get(ref);
          const basenameMatches = tree.filter(
            (entry) => entry.nodeType === "folder" && entry.slug === ref,
          );
          const folder = exact ?? (basenameMatches.length === 1 ? basenameMatches[0] : undefined);
          if (folder) resolvedFolderRefs.add(ref);
          return folder
            ? [
                {
                  path: folder.path,
                  title: folder.title || folder.slug,
                  children: directChildren(tree, folder.path),
                },
              ]
            : [];
        });
        const unresolved = missing.filter((ref) => !resolvedFolderRefs.has(ref));
        return {
          pages: resolved,
          ...(folders.length > 0 ? { folders } : {}),
          ...(unresolved.length > 0 ? { missing: unresolved } : {}),
        };
      }
      case "grep": {
        const pattern = toolInput.query?.trim();
        if (!pattern) throw new WikiCommandError('grep requires "query" (a regex pattern).');
        const matches = await this.repository.grep({
          workspaceId,
          pattern,
          ignoreCase: toolInput.ignoreCase ?? true,
          ...(toolInput.limit !== undefined ? { limit: toolInput.limit } : {}),
        });
        return { matches, ...(matches.length === 0 ? { hint: "No lines matched." } : {}) };
      }
      case "search": {
        const text = toolInput.query?.trim();
        if (!text) throw new WikiCommandError('search requires "query".');
        const hits = await this.repository.search({
          workspaceId,
          text,
          ...(toolInput.limit !== undefined ? { limit: toolInput.limit } : {}),
          ...(toolInput.offset !== undefined ? { offset: toolInput.offset } : {}),
        });
        return {
          hits: hits.map((hit) => ({
            path: hit.path,
            title: hit.title,
            kind: hit.kind,
            snippet: hit.snippet,
            updatedAt: hit.updatedAt.toISOString(),
          })),
        };
      }
      case "recent": {
        const since = resolveWikiSince(toolInput.since?.trim() || "2d");
        const changes = await this.repository.recentChanges({
          workspaceId,
          since,
          ...(toolInput.limit !== undefined ? { limit: toolInput.limit } : {}),
        });
        return {
          since: since.toISOString(),
          changes: changes.map((change) => ({
            path: change.path,
            title: change.title,
            writes: change.writes,
            addedLines: change.addedLines,
            removedLines: change.removedLines,
            lastChangedAt: change.lastChangedAt.toISOString(),
            ...(change.deleted ? { deleted: true } : {}),
          })),
        };
      }
      case "timeline": {
        const ref = requireSingleRef(toolInput, "timeline");
        const entries = await this.repository.listTimeline({
          workspaceId,
          path: ref,
          ...(toolInput.since?.trim() ? { since: resolveWikiSince(toolInput.since.trim()) } : {}),
        });
        return {
          page: ref,
          entries: entries.map((entry) => ({ at: entry.at.toISOString(), text: entry.text })),
        };
      }
      case "mkdir": {
        const path = toolInput.path?.trim();
        if (!path) throw new WikiCommandError('mkdir requires "path".');
        const result = await this.repository.createFolder({
          workspaceId,
          actorWorkosId,
          idempotencyKey,
          path,
          ...(toolInput.title?.trim() ? { title: toolInput.title.trim() } : {}),
        });
        return {
          action: result.action,
          path: `${result.path}/`,
          title: result.title,
          ...(result.createdAncestors.length > 0
            ? { createdAncestors: result.createdAncestors }
            : {}),
        };
      }
      case "write": {
        const path = toolInput.path?.trim();
        if (!path) throw new WikiCommandError('write requires "path".');
        if (toolInput.body === undefined) throw new WikiCommandError('write requires "body".');
        if (toolInput.kind !== undefined && !isValidWikiKind(toolInput.kind)) {
          throw new WikiCommandError(
            `Invalid kind "${toolInput.kind}". Use project, person, company, research, meeting, or other.`,
          );
        }
        const result = await this.repository.writePage({
          workspaceId,
          actorWorkosId,
          idempotencyKey,
          path,
          body: toolInput.body,
          ...(isValidWikiKind(toolInput.kind) ? { kind: toolInput.kind } : {}),
          ...(toolInput.title?.trim() ? { title: toolInput.title.trim() } : {}),
        });
        return {
          action: result.action,
          path: result.path,
          slug: result.slug,
          title: result.title,
          ...(result.createdAncestors.length > 0
            ? { createdAncestors: result.createdAncestors }
            : {}),
        };
      }
      case "move": {
        const ref = requireSingleRef(toolInput, "move");
        const to = toolInput.to?.trim();
        if (!to) {
          throw new WikiCommandError('move requires "to" (a parent path, or "/" for the root).');
        }
        const result = await this.repository.moveNode({
          workspaceId,
          actorWorkosId,
          path: ref,
          newParentPath: to === "/" ? null : to,
        });
        return {
          path: result.path,
          fromPath: result.fromPath,
          movedDescendants: result.movedDescendants,
          rewrittenReferrers: result.rewrittenReferrers,
          message: `Updated links in ${result.rewrittenReferrers.length} page(s).`,
        };
      }
      case "delete": {
        const ref = requireSingleRef(toolInput, "delete");
        const result = await this.repository.deletePage({
          workspaceId,
          actorWorkosId,
          path: ref,
          ...(toolInput.recursive !== undefined ? { recursive: toolInput.recursive } : {}),
        });
        return { deletedPaths: result.deletedPaths };
      }
      case "timeline-add": {
        const ref = requireSingleRef(toolInput, "timeline-add");
        const text = toolInput.text?.trim();
        if (!text) throw new WikiCommandError('timeline-add requires "text".');
        const at = toolInput.at?.trim() ? new Date(toolInput.at.trim()) : new Date();
        if (Number.isNaN(at.getTime())) {
          throw new WikiCommandError(`Invalid "at" timestamp "${toolInput.at}".`);
        }
        const entry = await this.repository.addTimelineEntry({
          workspaceId,
          actorWorkosId,
          idempotencyKey,
          path: ref,
          at,
          text,
        });
        return { page: ref, at: entry.at.toISOString(), text: entry.text };
      }
      default:
        throw new WikiCommandError(
          `Unsupported wiki command "${(toolInput as WikiToolInput).command}".`,
        );
    }
  }
}

function requireSingleRef(toolInput: WikiToolInput, command: string): string {
  const ref = firstWikiPageRef(toolInput);
  if (!ref) {
    throw new WikiCommandError(`${command} requires "pages" (one path or unique basename).`);
  }
  return ref;
}

function directChildren(tree: WikiCommandTreeNode[], parentPath: string): string[] {
  const depth = parentPath.split("/").length + 1;
  return tree
    .filter(
      (entry) =>
        isWikiDescendantPath(entry.path, parentPath) && entry.path.split("/").length === depth,
    )
    .map((entry) => (entry.nodeType === "folder" ? `${entry.path}/` : entry.path));
}

function wikiPathDepth(path: string): number {
  return path.split("/").length - 1;
}
