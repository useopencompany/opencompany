// The wiki entity and its access control. A workspace holds many named wikis;
// this module owns creating them, resolving which one a caller means, and
// deciding who may read or write each one.
//
// Access has two stored states and three displayed ones:
//   workspace  — every workspace member
//   restricted — only invited members (goat.wiki_members)
// "private" is `restricted` with no invites besides the creator, so there is no
// fourth state to keep consistent and no invalid combination to guard.
//
// Every wiki read and write in ./wiki takes a WikiScope resolved here, so a
// caller cannot reach a wiki it was never authorized for.

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { PRO_STRIPE_PRODUCT_KEY } from "./billing-constants";
import { getDb } from "./client";
import { type Wiki, type WikiAccessLevel, wikiMembers, wikis } from "./product-schema";

type DbClient = any;

export const DEFAULT_WIKI_NAME = "Wiki";
export const DEFAULT_WIKI_SLUG = "wiki";
const WIKI_SLUG_MAX_LENGTH = 64;
const WIKI_NAME_MAX_LENGTH = 120;
const WIKI_INSTRUCTIONS_MAX_BYTES = 20_000;

/**
 * The identity every wiki read and write is scoped to. `workspaceId` is carried
 * alongside `wikiId` because the wiki tables retain their workspace column for
 * ingestion dedup and workspace-level projections — it is never the authority
 * on which wiki a row belongs to.
 */
export type WikiScope = { workspaceId: string; wikiId: string };

export class WikiAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiAccessError";
  }
}

export function wikiSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, WIKI_SLUG_MAX_LENGTH)
    .replace(/-+$/u, "");
}

export function newWikiId() {
  return `goat_wiki_${randomUUID()}`;
}

/**
 * A user can reach a wiki when the workspace itself is reachable (the same
 * billing gate brains use) and either the wiki is workspace-access and they are
 * a workspace member, or they were invited to the restricted wiki. Mirrors
 * `brainAccessCondition` in ./workspaces so the two entities cannot drift.
 */
function wikiAccessCondition(userWorkosId: string) {
  return sql`(
    EXISTS (
      SELECT 1
      FROM "goat"."workspaces" access_workspace
      LEFT JOIN "goat"."workspace_billing" access_billing
        ON access_billing."workspace_id" = access_workspace."id"
      WHERE access_workspace."id" = ${wikis.workspaceId}
        AND (
          access_workspace."created_by_workos_id" = ${userWorkosId}
          OR (
            access_billing."plan" = 'pro'
            AND access_billing."stripe_product_key" = ${PRO_STRIPE_PRODUCT_KEY}
          )
        )
    )
    AND (
      (${wikis.access} = 'workspace' AND EXISTS (
        SELECT 1 FROM "goat"."workspace_members" wm
        WHERE wm."workspace_id" = ${wikis.workspaceId}
          AND wm."user_workos_id" = ${userWorkosId}
      ))
      OR
      (${wikis.access} = 'restricted' AND EXISTS (
        SELECT 1 FROM "goat"."wiki_members" wmem
        WHERE wmem."wiki_id" = ${wikis.id}
          AND wmem."user_workos_id" = ${userWorkosId}
      ))
    )
  )`;
}

/** Every wiki in the workspace the user may read, default first. */
export async function listWikisForUser(
  input: { userWorkosId: string; workspaceId: string },
  options: { db?: DbClient } = {},
): Promise<Wiki[]> {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(wikis)
    .where(and(eq(wikis.workspaceId, input.workspaceId), wikiAccessCondition(input.userWorkosId)))
    .orderBy(sql`${wikis.isDefault} DESC`, asc(wikis.createdAt));
}

/** Every wiki in the workspace, ignoring access. Admin surfaces only. */
export async function listWorkspaceWikis(
  workspaceId: string,
  options: { db?: DbClient } = {},
): Promise<Wiki[]> {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(wikis)
    .where(eq(wikis.workspaceId, workspaceId))
    .orderBy(sql`${wikis.isDefault} DESC`, asc(wikis.createdAt));
}

/**
 * Resolves the wiki a caller means and authorizes it in one query: an explicit
 * id or slug, otherwise the workspace's default wiki. Returns null when the wiki
 * does not exist *or* the user cannot reach it — callers must not distinguish the
 * two, because a distinguishable "exists but forbidden" leaks the wiki's
 * existence to non-members.
 */
export async function resolveWikiForUser(
  input: {
    userWorkosId: string;
    workspaceId: string;
    wikiId?: string | undefined;
    wikiSlug?: string | undefined;
  },
  options: { db?: DbClient } = {},
): Promise<Wiki | null> {
  const db = options.db ?? getDb();
  const selector = input.wikiId?.trim()
    ? eq(wikis.id, input.wikiId.trim())
    : input.wikiSlug?.trim()
      ? eq(wikis.slug, input.wikiSlug.trim())
      : eq(wikis.isDefault, true);
  const rows: Wiki[] = await db
    .select()
    .from(wikis)
    .where(
      and(
        eq(wikis.workspaceId, input.workspaceId),
        selector,
        wikiAccessCondition(input.userWorkosId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function requireWikiForUser(
  input: {
    userWorkosId: string;
    workspaceId: string;
    wikiId?: string | undefined;
    wikiSlug?: string | undefined;
  },
  options: { db?: DbClient } = {},
): Promise<Wiki> {
  const wiki = await resolveWikiForUser(input, options);
  if (!wiki) throw new WikiAccessError("Wiki not found.");
  return wiki;
}

/**
 * The workspace's default wiki id — the ingestion target.
 *
 * Ingestion sources stay workspace-level for now and only the default wiki
 * (which is always workspace-access) can be an ingestion target: a restricted
 * wiki fed by a shared Gmail or Slack connection would leak the whole team's
 * mail into a private space. Per-wiki ingestion routing is a follow-up; the
 * `wiki_id` columns on the ingestion tables exist so that lands as application
 * code rather than a second migration over the same tables.
 *
 * Fails closed: a workspace with no default wiki cannot ingest at all, rather
 * than silently writing rows that belong to no wiki.
 */
export async function requireIngestionWikiId(
  workspaceId: string,
  db: DbClient = getDb(),
): Promise<string> {
  const rows: Array<{ id: string }> = await db
    .select({ id: wikis.id })
    .from(wikis)
    .where(and(eq(wikis.workspaceId, workspaceId), eq(wikis.isDefault, true)))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) throw new WikiAccessError(`Workspace "${workspaceId}" has no default wiki.`);
  return id;
}

export async function getWikiById(
  wikiId: string,
  options: { db?: DbClient } = {},
): Promise<Wiki | null> {
  const db = options.db ?? getDb();
  const rows: Wiki[] = await db.select().from(wikis).where(eq(wikis.id, wikiId)).limit(1);
  return rows[0] ?? null;
}

export async function createWiki(
  input: {
    workspaceId: string;
    name: string;
    access: WikiAccessLevel;
    instructions?: string;
    isDefault?: boolean;
    createdByWorkosId: string;
  },
  options: { db?: DbClient } = {},
): Promise<Wiki> {
  const db = options.db ?? getDb();
  const name = input.name.trim().slice(0, WIKI_NAME_MAX_LENGTH);
  if (!name) throw new WikiAccessError("A wiki name is required.");
  const slug = await allocateWikiSlug(db, input.workspaceId, name);
  const rows: Wiki[] = await db
    .insert(wikis)
    .values({
      id: newWikiId(),
      workspaceId: input.workspaceId,
      name,
      slug,
      instructions: boundedInstructions(input.instructions ?? ""),
      access: input.access,
      isDefault: input.isDefault ?? false,
      createdByWorkosId: input.createdByWorkosId,
    })
    .returning();
  const wiki = rows[0];
  if (!wiki) throw new WikiAccessError("Failed to create the wiki.");
  if (wiki.access === "restricted") {
    // The creator is always a member, so a restricted wiki is never orphaned.
    await addWikiMember({ wikiId: wiki.id, userWorkosId: input.createdByWorkosId }, { db });
  }
  return wiki;
}

/**
 * The workspace's default wiki, created on demand. Workspaces provisioned before
 * wikis became entities are backfilled by migration 0269; this covers workspaces
 * created afterwards and makes the resolution path idempotent.
 */
export async function ensureDefaultWiki(
  input: { workspaceId: string; createdByWorkosId: string },
  options: { db?: DbClient } = {},
): Promise<Wiki> {
  const db = options.db ?? getDb();
  const existing: Wiki[] = await db
    .select()
    .from(wikis)
    .where(and(eq(wikis.workspaceId, input.workspaceId), eq(wikis.isDefault, true)))
    .limit(1);
  if (existing[0]) return existing[0];
  const rows: Wiki[] = await db
    .insert(wikis)
    .values({
      id: newWikiId(),
      workspaceId: input.workspaceId,
      name: DEFAULT_WIKI_NAME,
      slug: DEFAULT_WIKI_SLUG,
      access: "workspace",
      isDefault: true,
      createdByWorkosId: input.createdByWorkosId,
    })
    .onConflictDoNothing()
    .returning();
  if (rows[0]) return rows[0];
  // A concurrent caller won the unique partial index; read theirs.
  const settled: Wiki[] = await db
    .select()
    .from(wikis)
    .where(and(eq(wikis.workspaceId, input.workspaceId), eq(wikis.isDefault, true)))
    .limit(1);
  const wiki = settled[0];
  if (!wiki) throw new WikiAccessError("Failed to resolve the default wiki.");
  return wiki;
}

export async function updateWikiSettings(
  input: {
    wikiId: string;
    name?: string | undefined;
    instructions?: string | undefined;
  },
  options: { db?: DbClient } = {},
): Promise<Wiki> {
  const db = options.db ?? getDb();
  const name = input.name?.trim().slice(0, WIKI_NAME_MAX_LENGTH);
  if (input.name !== undefined && !name) throw new WikiAccessError("A wiki name is required.");
  const rows: Wiki[] = await db
    .update(wikis)
    .set({
      ...(name ? { name } : {}),
      ...(input.instructions !== undefined
        ? { instructions: boundedInstructions(input.instructions) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(wikis.id, input.wikiId))
    .returning();
  const wiki = rows[0];
  if (!wiki) throw new WikiAccessError("Wiki not found.");
  return wiki;
}

export async function updateWikiAccess(
  input: { wikiId: string; access: WikiAccessLevel; actingUserWorkosId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(wikis)
    .set({ access: input.access, updatedAt: new Date() })
    .where(eq(wikis.id, input.wikiId));
  if (input.access === "restricted") {
    // The acting user keeps access so the wiki never becomes unreachable.
    await addWikiMember({ wikiId: input.wikiId, userWorkosId: input.actingUserWorkosId }, { db });
  }
}

export async function listWikiMemberIds(
  wikiId: string,
  options: { db?: DbClient } = {},
): Promise<string[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ userWorkosId: wikiMembers.userWorkosId })
    .from(wikiMembers)
    .where(eq(wikiMembers.wikiId, wikiId));
  return rows.map((row: { userWorkosId: string }) => row.userWorkosId);
}

export async function addWikiMember(
  input: { wikiId: string; userWorkosId: string; addedByWorkosId?: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .insert(wikiMembers)
    .values({
      id: `goat_wkm_${randomUUID()}`,
      wikiId: input.wikiId,
      userWorkosId: input.userWorkosId,
      addedByWorkosId: input.addedByWorkosId ?? input.userWorkosId,
    })
    .onConflictDoNothing();
}

/** Makes the member list exactly `userWorkosIds`. */
export async function replaceWikiMembers(
  input: { wikiId: string; userWorkosIds: string[]; addedByWorkosId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const desired = [...new Set(input.userWorkosIds)];
  for (const userWorkosId of desired) {
    await addWikiMember(
      { wikiId: input.wikiId, userWorkosId, addedByWorkosId: input.addedByWorkosId },
      { db },
    );
  }
  await db.execute(sql`
    DELETE FROM "goat"."wiki_members"
    WHERE "wiki_id" = ${input.wikiId}
      AND ${
        desired.length > 0
          ? sql`"user_workos_id" NOT IN (${sql.join(
              desired.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`true`
      }
  `);
}

async function allocateWikiSlug(db: DbClient, workspaceId: string, name: string): Promise<string> {
  const base = wikiSlugFromName(name) || DEFAULT_WIKI_SLUG;
  const existing = await db
    .select({ slug: wikis.slug })
    .from(wikis)
    .where(eq(wikis.workspaceId, workspaceId));
  const used = new Set(existing.map((row: { slug: string }) => row.slug));
  let slug = base;
  for (let suffix = 2; used.has(slug); suffix += 1) {
    slug = `${base}-${suffix}`;
    if (suffix > 1_000) throw new WikiAccessError("Could not allocate a unique wiki slug.");
  }
  return slug;
}

function boundedInstructions(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= WIKI_INSTRUCTIONS_MAX_BYTES) return value;
  throw new WikiAccessError("Wiki instructions are too long.");
}
