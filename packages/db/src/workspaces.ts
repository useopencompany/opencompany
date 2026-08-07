import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { defaultGoatBrainFolderManifestEntries, normalizeGoatBrainId } from "../../brain/src/index";
import { GOAT_PRO_STRIPE_PRODUCT_KEY, goatCalendarMonthWindow } from "./billing-constants";
import { hashGoatBrainContent, seedDefaultGoatBrainFolders } from "./brain-files";
import { getDb } from "./client";
import { grantGoatMonthlyIncludedUsage } from "./credits";
import {
  type GoatBrain,
  type GoatBrainIntelligence,
  type GoatBrainVisibility,
  type GoatOnboarding,
  type GoatUser,
  type GoatWorkspace,
  type GoatWorkspaceRole,
  goatBrainFolders,
  goatBrainMembers,
  goatBrains,
  goatOnboarding,
  goatUsers,
  goatWorkspaceBilling,
  goatWorkspaceMembers,
  goatWorkspaces,
} from "./schema";

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
    EXISTS (
      SELECT 1
      FROM "goat"."workspaces" access_workspace
      LEFT JOIN "goat"."workspace_billing" access_billing
        ON access_billing."workspace_id" = access_workspace."id"
      WHERE access_workspace."id" = ${goatBrains.workspaceId}
        AND (
          access_workspace."created_by_workos_id" = ${userWorkosId}
          OR (
            access_billing."plan" = 'pro'
            AND access_billing."stripe_product_key" = ${GOAT_PRO_STRIPE_PRODUCT_KEY}
          )
        )
    )
    AND (
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
    )
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
    .leftJoin(goatWorkspaceBilling, eq(goatWorkspaceBilling.workspaceId, goatWorkspaces.id))
    .where(
      and(
        eq(goatWorkspaceMembers.userWorkosId, userWorkosId),
        or(
          eq(goatWorkspaces.createdByWorkosId, userWorkosId),
          and(
            eq(goatWorkspaceBilling.plan, "pro"),
            eq(goatWorkspaceBilling.stripeProductKey, GOAT_PRO_STRIPE_PRODUCT_KEY),
          ),
        ),
      ),
    )
    .orderBy(asc(goatWorkspaces.createdAt));
  return rows;
}

export async function hasOwnedGoatHobbyWorkspace(
  userWorkosId: string,
  options: { db?: DbClient } = {},
) {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ id: goatWorkspaces.id })
    .from(goatWorkspaces)
    .leftJoin(goatWorkspaceBilling, eq(goatWorkspaceBilling.workspaceId, goatWorkspaces.id))
    .where(
      and(
        eq(goatWorkspaces.createdByWorkosId, userWorkosId),
        sql`NOT COALESCE(${goatWorkspaceBilling.plan} = 'pro' AND ${goatWorkspaceBilling.stripeProductKey} = ${GOAT_PRO_STRIPE_PRODUCT_KEY}, false)`,
      ),
    )
    .limit(1);
  return rows.length > 0;
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

export type GoatBrainWithWorkspace = {
  brain: GoatBrain;
  workspace: { id: string; name: string; workosOrganizationId: string | null };
  workspaceRole: GoatWorkspaceRole;
};

// Every brain the user can read, across all their workspaces. Used by the
// user-level MCP connector to enumerate and resolve brains for one token.
export async function listAccessibleGoatBrainsForUser(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<GoatBrainWithWorkspace[]> {
  const db = options.db ?? getDb();
  const rows: Array<{
    brain: GoatBrain;
    workspace: GoatBrainWithWorkspace["workspace"];
    workspaceRole: GoatWorkspaceRole | null;
  }> = await db
    .select({
      brain: goatBrains,
      workspace: {
        id: goatWorkspaces.id,
        name: goatWorkspaces.name,
        workosOrganizationId: goatWorkspaces.workosOrganizationId,
      },
      workspaceRole: goatWorkspaceMembers.role,
    })
    .from(goatBrains)
    .innerJoin(goatWorkspaces, eq(goatWorkspaces.id, goatBrains.workspaceId))
    .leftJoin(
      goatWorkspaceMembers,
      and(
        eq(goatWorkspaceMembers.workspaceId, goatBrains.workspaceId),
        eq(goatWorkspaceMembers.userWorkosId, userWorkosId),
      ),
    )
    .where(brainAccessCondition(userWorkosId))
    .orderBy(asc(goatWorkspaces.createdAt), asc(goatBrains.createdAt));
  return rows.map((row) => ({
    ...row,
    workspaceRole: row.workspaceRole ?? "member",
  }));
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
    .innerJoin(goatWorkspaces, eq(goatWorkspaces.id, goatWorkspaceMembers.workspaceId))
    .leftJoin(goatWorkspaceBilling, eq(goatWorkspaceBilling.workspaceId, goatWorkspaces.id))
    .where(
      and(
        eq(goatWorkspaceMembers.workspaceId, input.workspaceId),
        eq(goatWorkspaceMembers.userWorkosId, input.userWorkosId),
        or(
          eq(goatWorkspaces.createdByWorkosId, input.userWorkosId),
          and(
            eq(goatWorkspaceBilling.plan, "pro"),
            eq(goatWorkspaceBilling.stripeProductKey, GOAT_PRO_STRIPE_PRODUCT_KEY),
          ),
        ),
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
  // Seed the current Hobby allowance immediately; the hourly billing sweep
  // repairs a transient failure without blocking sign-in.
  try {
    const { start, resetAt } = goatCalendarMonthWindow(new Date());
    await grantGoatMonthlyIncludedUsage({
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
export async function createGoatWorkspaceForUser(
  input: {
    workspaceId: string;
    workosOrganizationId: string;
    userWorkosId: string;
    name: string;
  },
  options: { db?: DbClient } = {},
): Promise<{ workspace: GoatWorkspace; brain: GoatBrain }> {
  const db = options.db ?? getDb();
  const name = input.name.trim();
  if (!name) throw new Error("Workspace name cannot be empty.");

  const brainId = newGoatBrainId(DEFAULT_GOAT_BRAIN_SLUG);
  const workspaceInsert = db
    .insert(goatWorkspaces)
    .values({
      id: input.workspaceId,
      workosOrganizationId: input.workosOrganizationId,
      name,
      createdByWorkosId: input.userWorkosId,
    })
    .returning();
  const membershipInsert = db.insert(goatWorkspaceMembers).values({
    id: `goat_wsm_${randomUUID()}`,
    workspaceId: input.workspaceId,
    userWorkosId: input.userWorkosId,
    role: "admin",
  });
  const brainInsert = db
    .insert(goatBrains)
    .values({
      id: brainId,
      workspaceId: input.workspaceId,
      name: DEFAULT_GOAT_BRAIN_NAME,
      slug: DEFAULT_GOAT_BRAIN_SLUG,
      visibility: "workspace",
      createdByWorkosId: input.userWorkosId,
    })
    .returning();
  const folderInserts = defaultGoatBrainFolderManifestEntries().map((folder) =>
    db.insert(goatBrainFolders).values({
      id: `goat_brain_folder_${hashGoatBrainContent(`${brainId}:${folder.path}`).slice(0, 24)}`,
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
    const { start, resetAt } = goatCalendarMonthWindow(new Date());
    await grantGoatMonthlyIncludedUsage({
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
      .select({
        id: goatWorkspaces.id,
        createdByWorkosId: goatWorkspaces.createdByWorkosId,
        plan: goatWorkspaceBilling.plan,
        stripeProductKey: goatWorkspaceBilling.stripeProductKey,
      })
      .from(goatWorkspaces)
      .leftJoin(goatWorkspaceBilling, eq(goatWorkspaceBilling.workspaceId, goatWorkspaces.id))
      .where(eq(goatWorkspaces.workosOrganizationId, membership.organizationId))
      .limit(1);
    const workspace = rows[0];
    if (!workspace) continue;
    const isPro =
      workspace.plan === "pro" && workspace.stripeProductKey === GOAT_PRO_STRIPE_PRODUCT_KEY;
    if (!isPro && workspace.createdByWorkosId !== input.userWorkosId) continue;
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

// Read live at ingest time (like enrichment) so switching a brain's tier
// applies to already-queued jobs. Missing rows fail to the included tier.
export async function getGoatBrainIntelligence(
  brainRef: string,
  db: DbClient = getDb(),
): Promise<GoatBrainIntelligence> {
  const rows = await db
    .select({ intelligence: goatBrains.intelligence })
    .from(goatBrains)
    .where(eq(goatBrains.id, brainRef))
    .limit(1);
  return rows[0]?.intelligence ?? "basic";
}

export async function updateGoatBrainIntelligence(
  input: { brainRef: string; intelligence: GoatBrainIntelligence },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const rows = await db
    .update(goatBrains)
    .set({ intelligence: input.intelligence, updatedAt: new Date() })
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

export async function countGoatWorkspaceMembers(
  workspaceId: string,
  options: { db?: DbClient } = {},
): Promise<number> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ total: sql<number>`count(*)::integer` })
    .from(goatWorkspaceMembers)
    .where(eq(goatWorkspaceMembers.workspaceId, workspaceId));
  return Number(rows[0]?.total ?? 0);
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

export async function updateGoatWorkspaceNameAndSlug(
  input: { workspaceId: string; name: string; slug: string | null },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(goatWorkspaces)
    .set({ name: input.name, slug: input.slug, updatedAt: new Date() })
    .where(eq(goatWorkspaces.id, input.workspaceId));
}

// A slug is free when no other workspace holds it. The excludeWorkspaceId keeps a
// workspace's own slug from reading as "taken" while it edits.
export async function isGoatWorkspaceSlugAvailable(
  input: { slug: string; excludeWorkspaceId?: string },
  options: { db?: DbClient } = {},
): Promise<boolean> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ id: goatWorkspaces.id })
    .from(goatWorkspaces)
    .where(eq(goatWorkspaces.slug, input.slug))
    .limit(2);
  return rows.every((row: { id: string }) => row.id === input.excludeWorkspaceId);
}

export async function markGoatUserOnboarded(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const now = new Date();
  await db
    .update(goatUsers)
    .set({ onboardedAt: now, updatedAt: now })
    .where(eq(goatUsers.workosUserId, userWorkosId));
}

export async function getGoatOnboarding(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<GoatOnboarding | null> {
  const db = options.db ?? getDb();
  const [row] = await db
    .select()
    .from(goatOnboarding)
    .where(eq(goatOnboarding.userWorkosId, userWorkosId))
    .limit(1);
  return row ?? null;
}

export async function upsertGoatOnboarding(
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
    .insert(goatOnboarding)
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
    .onConflictDoUpdate({ target: goatOnboarding.userWorkosId, set });
}
