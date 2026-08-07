import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { defaultBrainFolderManifestEntries, normalizeBrainId } from "../../brain/src/index";
import { calendarMonthWindow, PRO_STRIPE_PRODUCT_KEY } from "./billing-constants";
import { hashBrainContent, seedDefaultBrainFolders } from "./brain-files";
import { getDb } from "./client";
import { grantMonthlyIncludedUsage } from "./credits";
import {
  type Brain,
  type BrainIntelligence,
  type BrainVisibility,
  brainFolders,
  brainMembers,
  brains,
  type Onboarding,
  onboarding,
  type User,
  users,
  type Workspace,
  type WorkspaceRole,
  workspaceBilling,
  workspaceMembers,
  workspaces,
} from "./schema";

type DbClient = any;

export const DEFAULT_BRAIN_NAME = "General";
export const DEFAULT_BRAIN_SLUG = "general";
const BRAIN_ID_SUFFIX_LENGTH = 12;
const BRAIN_ID_MAX_LENGTH = 80;

export type WorkspaceWithRole = {
  workspace: Workspace;
  role: WorkspaceRole;
};

export type BrainAccess = {
  brain: Brain;
  workspaceRole: WorkspaceRole;
};

export type WorkspaceMemberWithUser = {
  member: { id: string; role: WorkspaceRole; createdAt: Date };
  user: User;
};

export function newWorkspaceId() {
  return `goat_ws_${randomUUID()}`;
}

export function newBrainId(name = "brain") {
  return readableBrainId(name, randomUUID());
}

export function defaultBrainIdForUser(userWorkosId: string) {
  return readableBrainId(DEFAULT_BRAIN_SLUG, userWorkosId);
}

function readableBrainId(name: string, entropy: string) {
  const suffix = createHash("sha256")
    .update(entropy)
    .digest("hex")
    .slice(0, BRAIN_ID_SUFFIX_LENGTH);
  const base = normalizeBrainId(name) || "brain";
  const baseMaxLength = BRAIN_ID_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, baseMaxLength).replace(/-+$/g, "")}-${suffix}`;
}

// Canonical brain access predicate: a brain is readable/writable when it is
// workspace-visible and the user is a workspace member, or restricted and the
// user is on the brain's member list. Reused by the Electric shape authorizer.
function brainAccessCondition(userWorkosId: string) {
  return sql`(
    EXISTS (
      SELECT 1
      FROM "goat"."workspaces" access_workspace
      LEFT JOIN "goat"."workspace_billing" access_billing
        ON access_billing."workspace_id" = access_workspace."id"
      WHERE access_workspace."id" = ${brains.workspaceId}
        AND (
          access_workspace."created_by_workos_id" = ${userWorkosId}
          OR (
            access_billing."plan" = 'pro'
            AND access_billing."stripe_product_key" = ${PRO_STRIPE_PRODUCT_KEY}
          )
        )
    )
    AND (
      (${brains.visibility} = 'workspace' AND EXISTS (
      SELECT 1 FROM "goat"."workspace_members" wm
      WHERE wm."workspace_id" = ${brains.workspaceId}
        AND wm."user_workos_id" = ${userWorkosId}
    ))
    OR
    (${brains.visibility} = 'restricted' AND EXISTS (
      SELECT 1 FROM "goat"."brain_members" bm
      WHERE bm."brain_id" = ${brains.id}
        AND bm."user_workos_id" = ${userWorkosId}
    ))
    )
  )`;
}

export async function listWorkspacesForUser(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<WorkspaceWithRole[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .leftJoin(workspaceBilling, eq(workspaceBilling.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaceMembers.userWorkosId, userWorkosId),
        or(
          eq(workspaces.createdByWorkosId, userWorkosId),
          and(
            eq(workspaceBilling.plan, "pro"),
            eq(workspaceBilling.stripeProductKey, PRO_STRIPE_PRODUCT_KEY),
          ),
        ),
      ),
    )
    .orderBy(asc(workspaces.createdAt));
  return rows;
}

export async function hasOwnedHobbyWorkspace(
  userWorkosId: string,
  options: { db?: DbClient } = {},
) {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .leftJoin(workspaceBilling, eq(workspaceBilling.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaces.createdByWorkosId, userWorkosId),
        sql`NOT COALESCE(${workspaceBilling.plan} = 'pro' AND ${workspaceBilling.stripeProductKey} = ${PRO_STRIPE_PRODUCT_KEY}, false)`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function listAccessibleBrains(
  input: { userWorkosId: string; workspaceId: string },
  options: { db?: DbClient } = {},
): Promise<Brain[]> {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(brains)
    .where(and(eq(brains.workspaceId, input.workspaceId), brainAccessCondition(input.userWorkosId)))
    .orderBy(asc(brains.createdAt));
}

export type BrainWithWorkspace = {
  brain: Brain;
  workspace: { id: string; name: string; workosOrganizationId: string | null };
  workspaceRole: WorkspaceRole;
};

// Every brain the user can read, across all their workspaces. Used by the
// user-level MCP connector to enumerate and resolve brains for one token.
export async function listAccessibleBrainsForUser(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<BrainWithWorkspace[]> {
  const db = options.db ?? getDb();
  const rows: Array<{
    brain: Brain;
    workspace: BrainWithWorkspace["workspace"];
    workspaceRole: WorkspaceRole | null;
  }> = await db
    .select({
      brain: brains,
      workspace: {
        id: workspaces.id,
        name: workspaces.name,
        workosOrganizationId: workspaces.workosOrganizationId,
      },
      workspaceRole: workspaceMembers.role,
    })
    .from(brains)
    .innerJoin(workspaces, eq(workspaces.id, brains.workspaceId))
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, brains.workspaceId),
        eq(workspaceMembers.userWorkosId, userWorkosId),
      ),
    )
    .where(brainAccessCondition(userWorkosId))
    .orderBy(asc(workspaces.createdAt), asc(brains.createdAt));
  return rows.map((row) => ({
    ...row,
    workspaceRole: row.workspaceRole ?? "member",
  }));
}

export async function getBrainAccess(
  input: { userWorkosId: string; brainRef: string },
  options: { db?: DbClient } = {},
): Promise<BrainAccess | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ brain: brains, role: workspaceMembers.role })
    .from(brains)
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, brains.workspaceId),
        eq(workspaceMembers.userWorkosId, input.userWorkosId),
      ),
    )
    .where(and(eq(brains.id, input.brainRef), brainAccessCondition(input.userWorkosId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { brain: row.brain, workspaceRole: row.role ?? "member" };
}

export async function requireBrainAccess(
  input: { userWorkosId: string; brainRef: string },
  options: { db?: DbClient } = {},
): Promise<BrainAccess> {
  const access = await getBrainAccess(input, options);
  if (!access) throw new Error("You do not have access to this brain.");
  return access;
}

export async function getWorkspaceRole(
  input: { userWorkosId: string; workspaceId: string },
  options: { db?: DbClient } = {},
): Promise<WorkspaceRole | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .leftJoin(workspaceBilling, eq(workspaceBilling.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        eq(workspaceMembers.userWorkosId, input.userWorkosId),
        or(
          eq(workspaces.createdByWorkosId, input.userWorkosId),
          and(
            eq(workspaceBilling.plan, "pro"),
            eq(workspaceBilling.stripeProductKey, PRO_STRIPE_PRODUCT_KEY),
          ),
        ),
      ),
    )
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function requireWorkspaceAdmin(
  input: { userWorkosId: string; workspaceId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const role = await getWorkspaceRole(input, options);
  if (role !== "admin") throw new Error("Only workspace admins can do this.");
}

// Human-readable name for attributing a user's own captures/uploads in
// ingestion prompts. Never falls back to the email: an address is not how the
// user should be named in prose.
export async function getUserDisplayName(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<string | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.workosUserId, userWorkosId))
    .limit(1);
  const user = rows[0];
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

export async function getDefaultBrainForUser(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<Brain | null> {
  const db = options.db ?? getDb();
  const workspaces = await listWorkspacesForUser(userWorkosId, { db });
  const first = workspaces[0];
  if (!first) return null;
  const brains = await listAccessibleBrains(
    { userWorkosId, workspaceId: first.workspace.id },
    { db },
  );
  return brains.find((brain) => brain.slug === DEFAULT_BRAIN_SLUG) ?? brains[0] ?? null;
}

// Bootstraps the personal workspace + "General" brain for a user that has no
// workspace membership yet. Deterministic ids (matching migration 0096's
// backfill) make concurrent sign-in requests converge on the same rows.
export async function createDefaultWorkspaceForUser(
  input: { userWorkosId: string; name: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const brainId = defaultBrainIdForUser(input.userWorkosId);
  await db
    .insert(workspaces)
    .values({
      id: `goat_ws_${input.userWorkosId}`,
      name: input.name,
      createdByWorkosId: input.userWorkosId,
    })
    .onConflictDoNothing();
  await db
    .insert(workspaceMembers)
    .values({
      id: `goat_wsm_${input.userWorkosId}`,
      workspaceId: `goat_ws_${input.userWorkosId}`,
      userWorkosId: input.userWorkosId,
      role: "admin",
    })
    .onConflictDoNothing();
  await db
    .insert(brains)
    .values({
      id: brainId,
      workspaceId: `goat_ws_${input.userWorkosId}`,
      name: DEFAULT_BRAIN_NAME,
      slug: DEFAULT_BRAIN_SLUG,
      visibility: "workspace",
      createdByWorkosId: input.userWorkosId,
    })
    .onConflictDoNothing();
  await seedDefaultBrainFolders(
    {
      brainRef: brainId,
      userWorkosId: input.userWorkosId,
    },
    { db },
  );
  // Seed the current Hobby allowance immediately; the hourly billing sweep
  // repairs a transient failure without blocking sign-in.
  try {
    const { start, resetAt } = calendarMonthWindow(new Date());
    await grantMonthlyIncludedUsage({
      workspaceId: `goat_ws_${input.userWorkosId}`,
      plan: "hobby",
      seatQuantity: 1,
      periodStart: start,
      periodEnd: resetAt,
      db,
    });
  } catch (error) {
    console.warn(
      `Failed to grant the monthly Hobby allowance for Goat workspace goat_ws_${input.userWorkosId}.`,
      error,
    );
  }
}

// Creates the local resources for a user-created WorkOS organization. The
// workspace, admin membership, default brain, and required folder rows are one
// Neon batch so a failed provision never leaves a partially usable workspace.
export async function createWorkspaceForUser(
  input: {
    workspaceId: string;
    workosOrganizationId: string;
    userWorkosId: string;
    name: string;
  },
  options: { db?: DbClient } = {},
): Promise<{ workspace: Workspace; brain: Brain }> {
  const db = options.db ?? getDb();
  const name = input.name.trim();
  if (!name) throw new Error("Workspace name cannot be empty.");

  const brainId = newBrainId(DEFAULT_BRAIN_SLUG);
  const workspaceInsert = db
    .insert(workspaces)
    .values({
      id: input.workspaceId,
      workosOrganizationId: input.workosOrganizationId,
      name,
      createdByWorkosId: input.userWorkosId,
    })
    .returning();
  const membershipInsert = db.insert(workspaceMembers).values({
    id: `goat_wsm_${randomUUID()}`,
    workspaceId: input.workspaceId,
    userWorkosId: input.userWorkosId,
    role: "admin",
  });
  const brainInsert = db
    .insert(brains)
    .values({
      id: brainId,
      workspaceId: input.workspaceId,
      name: DEFAULT_BRAIN_NAME,
      slug: DEFAULT_BRAIN_SLUG,
      visibility: "workspace",
      createdByWorkosId: input.userWorkosId,
    })
    .returning();
  const folderInserts = defaultBrainFolderManifestEntries().map((folder) =>
    db.insert(brainFolders).values({
      id: `goat_brain_folder_${hashBrainContent(`${brainId}:${folder.path}`).slice(0, 24)}`,
      userWorkosId: input.userWorkosId,
      brainRef: brainId,
      path: folder.path,
      source: folder.source,
    }),
  );

  const [workspaceRows, , brainRows] = await db.batch([
    workspaceInsert,
    membershipInsert,
    brainInsert,
    ...folderInserts,
  ]);
  const workspace = workspaceRows[0];
  const brain = brainRows[0];
  if (!workspace || !brain) throw new Error("Could not persist the Goat workspace.");

  // Monthly-allowance writes are idempotent and deliberately non-blocking: a
  // billing outage must not turn a successfully created organization into a
  // partially cleaned-up workspace. The hourly sweep repairs the grant.
  try {
    const { start, resetAt } = calendarMonthWindow(new Date());
    await grantMonthlyIncludedUsage({
      workspaceId: workspace.id,
      plan: "hobby",
      seatQuantity: 1,
      periodStart: start,
      periodEnd: resetAt,
      db,
    });
  } catch (error) {
    console.warn(
      `Failed to grant the monthly Hobby allowance for Goat workspace ${workspace.id}.`,
      error,
    );
  }

  return { workspace, brain };
}

// Adopts local memberships for WorkOS organizations the user already belongs
// to (the invite-acceptance landing path). Organizations without a matching
// goat workspace row (e.g. web-app organizations in the shared WorkOS
// environment) are skipped.
export async function adoptWorkspaceMembershipsFromOrgs(
  input: {
    userWorkosId: string;
    memberships: Array<{ organizationId: string; role: WorkspaceRole }>;
  },
  options: { db?: DbClient } = {},
): Promise<number> {
  if (input.memberships.length === 0) return 0;
  const db = options.db ?? getDb();
  let adopted = 0;
  for (const membership of input.memberships) {
    const rows = await db
      .select({
        id: workspaces.id,
        createdByWorkosId: workspaces.createdByWorkosId,
        plan: workspaceBilling.plan,
        stripeProductKey: workspaceBilling.stripeProductKey,
      })
      .from(workspaces)
      .leftJoin(workspaceBilling, eq(workspaceBilling.workspaceId, workspaces.id))
      .where(eq(workspaces.workosOrganizationId, membership.organizationId))
      .limit(1);
    const workspace = rows[0];
    if (!workspace) continue;
    const isPro = workspace.plan === "pro" && workspace.stripeProductKey === PRO_STRIPE_PRODUCT_KEY;
    if (!isPro && workspace.createdByWorkosId !== input.userWorkosId) continue;
    await db
      .insert(workspaceMembers)
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

export async function createBrain(
  input: {
    workspaceId: string;
    name: string;
    description?: string | null;
    visibility: BrainVisibility;
    createdByWorkosId: string;
  },
  options: { db?: DbClient } = {},
): Promise<Brain> {
  const db = options.db ?? getDb();
  const name = input.name.trim();
  if (!name) throw new Error("Brain name cannot be empty.");
  const baseSlug = normalizeBrainId(name) || "brain";
  const existing = await db
    .select({ slug: brains.slug })
    .from(brains)
    .where(eq(brains.workspaceId, input.workspaceId));
  const used = new Set(existing.map((row: { slug: string }) => row.slug));
  let slug = baseSlug;
  for (let i = 2; used.has(slug); i++) {
    slug = `${baseSlug}-${i}`;
    if (i > 1000) throw new Error("Could not allocate a unique brain slug.");
  }

  const rows = await db
    .insert(brains)
    .values({
      id: newBrainId(slug),
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
  await seedDefaultBrainFolders(
    { brainRef: brain.id, userWorkosId: input.createdByWorkosId },
    { db },
  );
  if (input.visibility === "restricted") {
    await db
      .insert(brainMembers)
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

export async function updateBrainVisibility(
  input: { brainRef: string; visibility: BrainVisibility; actingUserWorkosId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(brains)
    .set({ visibility: input.visibility, updatedAt: new Date() })
    .where(eq(brains.id, input.brainRef));
  if (input.visibility === "restricted") {
    // The acting admin keeps access so the brain never becomes orphaned.
    await db
      .insert(brainMembers)
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
export async function getBrainEnrichmentEnabled(
  brainRef: string,
  db: DbClient = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ enrichmentEnabled: brains.enrichmentEnabled })
    .from(brains)
    .where(eq(brains.id, brainRef))
    .limit(1);
  return rows[0]?.enrichmentEnabled ?? false;
}

export async function updateBrainEnrichmentEnabled(
  input: { brainRef: string; enabled: boolean },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const rows = await db
    .update(brains)
    .set({ enrichmentEnabled: input.enabled, updatedAt: new Date() })
    .where(eq(brains.id, input.brainRef))
    .returning({ id: brains.id });
  if (rows.length === 0) throw new Error("Brain not found.");
}

// Read live at ingest time (like enrichment) so switching a brain's tier
// applies to already-queued jobs. Missing rows fail to the included tier.
export async function getBrainIntelligence(
  brainRef: string,
  db: DbClient = getDb(),
): Promise<BrainIntelligence> {
  const rows = await db
    .select({ intelligence: brains.intelligence })
    .from(brains)
    .where(eq(brains.id, brainRef))
    .limit(1);
  return rows[0]?.intelligence ?? "basic";
}

export async function updateBrainIntelligence(
  input: { brainRef: string; intelligence: BrainIntelligence },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const rows = await db
    .update(brains)
    .set({ intelligence: input.intelligence, updatedAt: new Date() })
    .where(eq(brains.id, input.brainRef))
    .returning({ id: brains.id });
  if (rows.length === 0) throw new Error("Brain not found.");
}

export async function replaceBrainMembers(
  input: { brainRef: string; userWorkosIds: string[]; addedByWorkosId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const desired = new Set(input.userWorkosIds);
  const desiredRows = [...desired].map((userWorkosId) => ({
    id: `goat_brm_${randomUUID()}`,
    userWorkosId,
  }));
  const desiredMembers =
    desiredRows.length > 0
      ? sql`SELECT * FROM (VALUES ${sql.join(
          desiredRows.map((row) => sql`(${row.userWorkosId}, ${row.id})`),
          sql`, `,
        )}) AS desired(user_workos_id, id)`
      : sql`SELECT NULL::text AS user_workos_id, NULL::text AS id WHERE false`;

  // One statement keeps access changes and personal-source cleanup atomic on
  // both pooled Postgres and the neon-http web client. A member who is removed
  // from a restricted brain must not keep feeding it through a personal
  // integration they attached while they still had access.
  await db.execute(sql`
    WITH desired_members AS (${desiredMembers}),
    deleted_members AS (
      DELETE FROM goat.brain_members bm
      WHERE bm.brain_id = ${input.brainRef}
        AND NOT EXISTS (
          SELECT 1 FROM desired_members desired
          WHERE desired.user_workos_id = bm.user_workos_id
        )
      RETURNING bm.id
    ),
    inserted_members AS (
      INSERT INTO goat.brain_members (id, brain_id, user_workos_id, added_by_workos_id)
      SELECT desired.id, ${input.brainRef}, desired.user_workos_id, ${input.addedByWorkosId}
      FROM desired_members desired
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    DELETE FROM goat.brain_sources bs
    USING goat.integrations integration
    WHERE bs.brain_id = ${input.brainRef}
      AND bs.integration_id = integration.id
      AND integration.workspace_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM desired_members desired
        WHERE desired.user_workos_id = bs.user_workos_id
      )
  `);
}

export async function listBrainMemberIds(
  brainRef: string,
  options: { db?: DbClient } = {},
): Promise<string[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ userWorkosId: brainMembers.userWorkosId })
    .from(brainMembers)
    .where(eq(brainMembers.brainId, brainRef));
  return rows.map((row: { userWorkosId: string }) => row.userWorkosId);
}

export async function listWorkspaceMembers(
  workspaceId: string,
  options: { db?: DbClient } = {},
): Promise<WorkspaceMemberWithUser[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({
      member: {
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        createdAt: workspaceMembers.createdAt,
      },
      user: users,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.workosUserId, workspaceMembers.userWorkosId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt));
  return rows;
}

export async function countWorkspaceMembers(
  workspaceId: string,
  options: { db?: DbClient } = {},
): Promise<number> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ total: sql<number>`count(*)::integer` })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return Number(rows[0]?.total ?? 0);
}

export async function removeWorkspaceMember(
  input: { workspaceId: string; userWorkosId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  // Drop the member's restricted-brain access in this workspace first.
  const workspaceBrains = await db
    .select({ id: brains.id })
    .from(brains)
    .where(eq(brains.workspaceId, input.workspaceId));
  for (const brain of workspaceBrains) {
    await db
      .delete(brainMembers)
      .where(
        and(eq(brainMembers.brainId, brain.id), eq(brainMembers.userWorkosId, input.userWorkosId)),
      );
  }
  // Detach the member's personal-integration brain sources in this workspace:
  // new content stops flowing, already-ingested brain content stays (the
  // pointer/copy rule). Workspace-owned integrations (github, jamie) keep the
  // leaving member as user_workos_id attribution and must NOT be touched —
  // the workspace_id IS NULL filter guarantees that.
  await db.execute(sql`
    DELETE FROM goat.brain_sources bs
    USING goat.brains b, goat.integrations i
    WHERE bs.brain_id = b.id
      AND b.workspace_id = ${input.workspaceId}
      AND bs.integration_id = i.id
      AND i.user_workos_id = ${input.userWorkosId}
      AND i.workspace_id IS NULL
  `);
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        eq(workspaceMembers.userWorkosId, input.userWorkosId),
      ),
    );
}

export async function setWorkspaceOrganizationId(
  input: { workspaceId: string; workosOrganizationId: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(workspaces)
    .set({ workosOrganizationId: input.workosOrganizationId, updatedAt: new Date() })
    .where(eq(workspaces.id, input.workspaceId));
}

export async function updateWorkspaceName(
  input: { workspaceId: string; name: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(workspaces)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(workspaces.id, input.workspaceId));
}

export async function updateWorkspaceNameAndSlug(
  input: { workspaceId: string; name: string; slug: string | null },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(workspaces)
    .set({ name: input.name, slug: input.slug, updatedAt: new Date() })
    .where(eq(workspaces.id, input.workspaceId));
}

// A slug is free when no other workspace holds it. The excludeWorkspaceId keeps a
// workspace's own slug from reading as "taken" while it edits.
export async function isWorkspaceSlugAvailable(
  input: { slug: string; excludeWorkspaceId?: string },
  options: { db?: DbClient } = {},
): Promise<boolean> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, input.slug))
    .limit(2);
  return rows.every((row: { id: string }) => row.id === input.excludeWorkspaceId);
}

export async function markUserOnboarded(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const now = new Date();
  await db
    .update(users)
    .set({ onboardedAt: now, updatedAt: now })
    .where(eq(users.workosUserId, userWorkosId));
}

export async function getOnboarding(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<Onboarding | null> {
  const db = options.db ?? getDb();
  const [row] = await db
    .select()
    .from(onboarding)
    .where(eq(onboarding.userWorkosId, userWorkosId))
    .limit(1);
  return row ?? null;
}

export async function upsertOnboarding(
  input: {
    userWorkosId: string;
    workspaceId?: string | null;
    referralSource?: string | null;
    role?: string | null;
    building?: string | null;
    companyDomain?: string | null;
    contextUrls?: string[] | null;
  },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const now = new Date();
  // Only overwrite the fields the caller actually provided, so a later step
  // doesn't wipe an earlier one.
  const set: Record<string, unknown> = { updatedAt: now };
  if (input.workspaceId !== undefined) set.workspaceId = input.workspaceId;
  if (input.referralSource !== undefined) set.referralSource = input.referralSource;
  if (input.role !== undefined) set.role = input.role;
  if (input.building !== undefined) set.building = input.building;
  if (input.companyDomain !== undefined) set.companyDomain = input.companyDomain;
  if (input.contextUrls !== undefined) set.contextUrls = input.contextUrls;

  await db
    .insert(onboarding)
    .values({
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId ?? null,
      referralSource: input.referralSource ?? null,
      role: input.role ?? null,
      building: input.building ?? null,
      companyDomain: input.companyDomain ?? null,
      contextUrls: input.contextUrls ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: onboarding.userWorkosId, set });
}
