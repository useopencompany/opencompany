import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { normalizeGoatBrainId } from "../../goat-brain/src/index";
import { getDb } from "./client";
import { seedDefaultGoatBrainFolders } from "./goat-brain-files";
import {
  type GoatBrain,
  type GoatBrainVisibility,
  type GoatUser,
  type GoatWorkspace,
  type GoatWorkspaceRole,
  goatBrainMembers,
  goatBrains,
  goatUsers,
  goatWorkspaceMembers,
  goatWorkspaces,
} from "./goat-schema";

type DbClient = any;

export const DEFAULT_GOAT_BRAIN_NAME = "General";
export const DEFAULT_GOAT_BRAIN_SLUG = "general";
const GOAT_BRAIN_ID_SUFFIX_LENGTH = 12;
const GOAT_BRAIN_ID_MAX_LENGTH = 80;

export type GoatWorkspaceWithRole = {
  workspace: GoatWorkspace;
  role: GoatWorkspaceRole;
};

export type GoatBrainAccess = {
  brain: GoatBrain;
  workspaceRole: GoatWorkspaceRole;
};

export type GoatWorkspaceMemberWithUser = {
  member: { id: string; role: GoatWorkspaceRole; createdAt: Date };
  user: GoatUser;
};

export function newGoatWorkspaceId() {
  return `goat_ws_${randomUUID()}`;
}

export function newGoatBrainId(name = "brain") {
  return readableGoatBrainId(name, randomUUID());
}

export function defaultGoatBrainIdForUser(userWorkosId: string) {
  return readableGoatBrainId(DEFAULT_GOAT_BRAIN_SLUG, userWorkosId);
}

function readableGoatBrainId(name: string, entropy: string) {
  const suffix = createHash("sha256")
    .update(entropy)
    .digest("hex")
    .slice(0, GOAT_BRAIN_ID_SUFFIX_LENGTH);
  const base = normalizeGoatBrainId(name) || "brain";
  const baseMaxLength = GOAT_BRAIN_ID_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, baseMaxLength).replace(/-+$/g, "")}-${suffix}`;
}

// Canonical brain access predicate: a brain is readable/writable when it is
// workspace-visible and the user is a workspace member, or restricted and the
// user is on the brain's member list. Reused by the Electric shape authorizer.
function brainAccessCondition(userWorkosId: string) {
  return sql`(
    (${goatBrains.visibility} = 'workspace' AND EXISTS (
      SELECT 1 FROM "goat"."workspace_members" wm
      WHERE wm."workspace_id" = ${goatBrains.workspaceId}
        AND wm."user_workos_id" = ${userWorkosId}
    ))
    OR
    (${goatBrains.visibility} = 'restricted' AND EXISTS (
      SELECT 1 FROM "goat"."brain_members" bm
      WHERE bm."brain_id" = ${goatBrains.id}
        AND bm."user_workos_id" = ${userWorkosId}
    ))
  )`;
}

export async function listGoatWorkspacesForUser(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<GoatWorkspaceWithRole[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ workspace: goatWorkspaces, role: goatWorkspaceMembers.role })
    .from(goatWorkspaceMembers)
    .innerJoin(goatWorkspaces, eq(goatWorkspaces.id, goatWorkspaceMembers.workspaceId))
    .where(eq(goatWorkspaceMembers.userWorkosId, userWorkosId))
    .orderBy(asc(goatWorkspaces.createdAt));
  return rows;
}

export async function listAccessibleGoatBrains(
  input: { userWorkosId: string; workspaceId: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrain[]> {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(goatBrains)
    .where(
      and(eq(goatBrains.workspaceId, input.workspaceId), brainAccessCondition(input.userWorkosId)),
    )
    .orderBy(asc(goatBrains.createdAt));
}

export async function getGoatBrainAccess(
  input: { userWorkosId: string; brainRef: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrainAccess | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ brain: goatBrains, role: goatWorkspaceMembers.role })
    .from(goatBrains)
    .leftJoin(
      goatWorkspaceMembers,
      and(
        eq(goatWorkspaceMembers.workspaceId, goatBrains.workspaceId),
        eq(goatWorkspaceMembers.userWorkosId, input.userWorkosId),
      ),
    )
    .where(and(eq(goatBrains.id, input.brainRef), brainAccessCondition(input.userWorkosId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { brain: row.brain, workspaceRole: row.role ?? "member" };
}

export async function requireGoatBrainAccess(
  input: { userWorkosId: string; brainRef: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrainAccess> {
  const access = await getGoatBrainAccess(input, options);
  if (!access) throw new Error("You do not have access to this brain.");
  return access;
}

export async function getGoatWorkspaceRole(
  input: { userWorkosId: string; workspaceId: string },
  options: { db?: DbClient } = {},
): Promise<GoatWorkspaceRole | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ role: goatWorkspaceMembers.role })
    .from(goatWorkspaceMembers)
    .where(
      and(
        eq(goatWorkspaceMembers.workspaceId, input.workspaceId),
        eq(goatWorkspaceMembers.userWorkosId, input.userWorkosId),
      ),
    )
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function requireGoatWorkspaceAdmin(
  input: { userWorkosId: string; workspaceId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const role = await getGoatWorkspaceRole(input, options);
  if (role !== "admin") throw new Error("Only workspace admins can do this.");
}

// Human-readable name for attributing a user's own captures/uploads in
// ingestion prompts. Never falls back to the email: an address is not how the
// user should be named in prose.
export async function getGoatUserDisplayName(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<string | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ firstName: goatUsers.firstName, lastName: goatUsers.lastName })
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, userWorkosId))
    .limit(1);
  const user = rows[0];
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

export async function getDefaultGoatBrainForUser(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<GoatBrain | null> {
  const db = options.db ?? getDb();
  const workspaces = await listGoatWorkspacesForUser(userWorkosId, { db });
  const first = workspaces[0];
  if (!first) return null;
  const brains = await listAccessibleGoatBrains(
    { userWorkosId, workspaceId: first.workspace.id },
    { db },
  );
  return brains.find((brain) => brain.slug === DEFAULT_GOAT_BRAIN_SLUG) ?? brains[0] ?? null;
}

// Bootstraps the personal workspace + "General" brain for a user that has no
// workspace membership yet. Deterministic ids (matching migration 0096's
// backfill) make concurrent sign-in requests converge on the same rows.
export async function createDefaultGoatWorkspaceForUser(
  input: { userWorkosId: string; name: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const brainId = defaultGoatBrainIdForUser(input.userWorkosId);
  await db
    .insert(goatWorkspaces)
    .values({
      id: `goat_ws_${input.userWorkosId}`,
      name: input.name,
      createdByWorkosId: input.userWorkosId,
    })
    .onConflictDoNothing();
  await db
    .insert(goatWorkspaceMembers)
    .values({
      id: `goat_wsm_${input.userWorkosId}`,
      workspaceId: `goat_ws_${input.userWorkosId}`,
      userWorkosId: input.userWorkosId,
      role: "admin",
    })
    .onConflictDoNothing();
  await db
    .insert(goatBrains)
    .values({
      id: brainId,
      workspaceId: `goat_ws_${input.userWorkosId}`,
      name: DEFAULT_GOAT_BRAIN_NAME,
      slug: DEFAULT_GOAT_BRAIN_SLUG,
      visibility: "workspace",
      createdByWorkosId: input.userWorkosId,
    })
    .onConflictDoNothing();
  await seedDefaultGoatBrainFolders(
    {
      brainRef: brainId,
      userWorkosId: input.userWorkosId,
    },
    { db },
  );
}

// Adopts local memberships for WorkOS organizations the user already belongs
// to (the invite-acceptance landing path). Organizations without a matching
// goat workspace row (e.g. web-app organizations in the shared WorkOS
// environment) are skipped.
export async function adoptGoatWorkspaceMembershipsFromOrgs(
  input: {
    userWorkosId: string;
    memberships: Array<{ organizationId: string; role: GoatWorkspaceRole }>;
  },
  options: { db?: DbClient } = {},
): Promise<number> {
  if (input.memberships.length === 0) return 0;
  const db = options.db ?? getDb();
  let adopted = 0;
  for (const membership of input.memberships) {
    const rows = await db
      .select({ id: goatWorkspaces.id })
      .from(goatWorkspaces)
      .where(eq(goatWorkspaces.workosOrganizationId, membership.organizationId))
      .limit(1);
    const workspace = rows[0];
    if (!workspace) continue;
    await db
      .insert(goatWorkspaceMembers)
      .values({
        id: `goat_wsm_${randomUUID()}`,
        workspaceId: workspace.id,
        userWorkosId: input.userWorkosId,
        role: membership.role,
      })
      .onConflictDoNothing();
    adopted += 1;
  }
  return adopted;
}

export async function createGoatBrain(
  input: {
    workspaceId: string;
    name: string;
    description?: string | null;
    visibility: GoatBrainVisibility;
    createdByWorkosId: string;
  },
  options: { db?: DbClient } = {},
): Promise<GoatBrain> {
  const db = options.db ?? getDb();
  const name = input.name.trim();
  if (!name) throw new Error("Brain name cannot be empty.");
  const baseSlug = normalizeGoatBrainId(name) || "brain";
  const existing = await db
    .select({ slug: goatBrains.slug })
    .from(goatBrains)
    .where(eq(goatBrains.workspaceId, input.workspaceId));
  const used = new Set(existing.map((row: { slug: string }) => row.slug));
  let slug = baseSlug;
  for (let i = 2; used.has(slug); i++) {
    slug = `${baseSlug}-${i}`;
    if (i > 1000) throw new Error("Could not allocate a unique brain slug.");
  }

  const rows = await db
    .insert(goatBrains)
    .values({
      id: newGoatBrainId(slug),
      workspaceId: input.workspaceId,
      name,
      slug,
      description: input.description?.trim() || null,
      visibility: input.visibility,
      createdByWorkosId: input.createdByWorkosId,
    })
    .returning();
  const brain = rows[0];
  if (!brain) throw new Error("Failed to create brain.");
  await seedDefaultGoatBrainFolders(
    { brainRef: brain.id, userWorkosId: input.createdByWorkosId },
    { db },
  );
  if (input.visibility === "restricted") {
    await db
      .insert(goatBrainMembers)
      .values({
        id: `goat_brm_${randomUUID()}`,
        brainId: brain.id,
        userWorkosId: input.createdByWorkosId,
        addedByWorkosId: input.createdByWorkosId,
      })
      .onConflictDoNothing();
  }
  return brain;
}

export async function updateGoatBrainVisibility(
  input: { brainRef: string; visibility: GoatBrainVisibility; actingUserWorkosId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(goatBrains)
    .set({ visibility: input.visibility, updatedAt: new Date() })
    .where(eq(goatBrains.id, input.brainRef));
  if (input.visibility === "restricted") {
    // The acting admin keeps access so the brain never becomes orphaned.
    await db
      .insert(goatBrainMembers)
      .values({
        id: `goat_brm_${randomUUID()}`,
        brainId: input.brainRef,
        userWorkosId: input.actingUserWorkosId,
        addedByWorkosId: input.actingUserWorkosId,
      })
      .onConflictDoNothing();
  }
}

// Read live at ingest time so an owner toggling enrichment off applies to
// already-queued jobs. Missing rows fail closed.
export async function getGoatBrainEnrichmentEnabled(
  brainRef: string,
  db: DbClient = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ enrichmentEnabled: goatBrains.enrichmentEnabled })
    .from(goatBrains)
    .where(eq(goatBrains.id, brainRef))
    .limit(1);
  return rows[0]?.enrichmentEnabled ?? false;
}

export async function updateGoatBrainEnrichmentEnabled(
  input: { brainRef: string; enabled: boolean },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const rows = await db
    .update(goatBrains)
    .set({ enrichmentEnabled: input.enabled, updatedAt: new Date() })
    .where(eq(goatBrains.id, input.brainRef))
    .returning({ id: goatBrains.id });
  if (rows.length === 0) throw new Error("Brain not found.");
}

export async function replaceGoatBrainMembers(
  input: { brainRef: string; userWorkosIds: string[]; addedByWorkosId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const desired = new Set(input.userWorkosIds);
  const existing = await db
    .select({ id: goatBrainMembers.id, userWorkosId: goatBrainMembers.userWorkosId })
    .from(goatBrainMembers)
    .where(eq(goatBrainMembers.brainId, input.brainRef));
  for (const row of existing) {
    if (!desired.has(row.userWorkosId)) {
      await db.delete(goatBrainMembers).where(eq(goatBrainMembers.id, row.id));
    }
  }
  const present = new Set(existing.map((row: { userWorkosId: string }) => row.userWorkosId));
  for (const userWorkosId of desired) {
    if (present.has(userWorkosId)) continue;
    await db
      .insert(goatBrainMembers)
      .values({
        id: `goat_brm_${randomUUID()}`,
        brainId: input.brainRef,
        userWorkosId,
        addedByWorkosId: input.addedByWorkosId,
      })
      .onConflictDoNothing();
  }
}

export async function listGoatBrainMemberIds(
  brainRef: string,
  options: { db?: DbClient } = {},
): Promise<string[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ userWorkosId: goatBrainMembers.userWorkosId })
    .from(goatBrainMembers)
    .where(eq(goatBrainMembers.brainId, brainRef));
  return rows.map((row: { userWorkosId: string }) => row.userWorkosId);
}

export async function listGoatWorkspaceMembers(
  workspaceId: string,
  options: { db?: DbClient } = {},
): Promise<GoatWorkspaceMemberWithUser[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({
      member: {
        id: goatWorkspaceMembers.id,
        role: goatWorkspaceMembers.role,
        createdAt: goatWorkspaceMembers.createdAt,
      },
      user: goatUsers,
    })
    .from(goatWorkspaceMembers)
    .innerJoin(goatUsers, eq(goatUsers.workosUserId, goatWorkspaceMembers.userWorkosId))
    .where(eq(goatWorkspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(goatWorkspaceMembers.createdAt));
  return rows;
}

export async function removeGoatWorkspaceMember(
  input: { workspaceId: string; userWorkosId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  // Drop the member's restricted-brain access in this workspace first.
  const brains = await db
    .select({ id: goatBrains.id })
    .from(goatBrains)
    .where(eq(goatBrains.workspaceId, input.workspaceId));
  for (const brain of brains) {
    await db
      .delete(goatBrainMembers)
      .where(
        and(
          eq(goatBrainMembers.brainId, brain.id),
          eq(goatBrainMembers.userWorkosId, input.userWorkosId),
        ),
      );
  }
  await db
    .delete(goatWorkspaceMembers)
    .where(
      and(
        eq(goatWorkspaceMembers.workspaceId, input.workspaceId),
        eq(goatWorkspaceMembers.userWorkosId, input.userWorkosId),
      ),
    );
}

export async function setGoatWorkspaceOrganizationId(
  input: { workspaceId: string; workosOrganizationId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(goatWorkspaces)
    .set({ workosOrganizationId: input.workosOrganizationId, updatedAt: new Date() })
    .where(eq(goatWorkspaces.id, input.workspaceId));
}

export async function updateGoatWorkspaceName(
  input: { workspaceId: string; name: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(goatWorkspaces)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(goatWorkspaces.id, input.workspaceId));
}
