import { createHash, randomUUID } from "node:crypto";
import { newResourceId } from "@opencompany/core/resource-ids";
import { DEFAULT_SANDBOX_SIZE, type SandboxSize } from "@opencompany/core/sandbox-sizes";
import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { calendarMonthWindow, PRO_STRIPE_PRODUCT_KEY } from "./billing-constants";
import { getDb } from "./client";
import { grantMonthlyIncludedUsage } from "./credits";
import {
  type Onboarding,
  onboarding,
  type User,
  users,
  type Workspace,
  type WorkspaceRole,
  wikiMembers,
  wikis,
  workspaceBilling,
  workspaceMembers,
  workspaces,
} from "./product-schema";
import { DEFAULT_WIKI_NAME, DEFAULT_WIKI_SLUG, newWikiId } from "./wikis";

type DbClient = any;

export type WorkspaceWithRole = {
  workspace: Workspace;
  role: WorkspaceRole;
};

export type WorkspaceMemberWithUser = {
  member: { id: string; role: WorkspaceRole; createdAt: Date };
  user: User;
};

export function newWorkspaceId() {
  return newResourceId("workspace");
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

// The workspaces a user created that are not on a paid Pro subscription: the
// set the Hobby workspace cap counts. Upgrading one to Pro removes it here.
function ownedHobbyWorkspaceFilter(userWorkosId: string) {
  return and(
    eq(workspaces.createdByWorkosId, userWorkosId),
    sql`NOT COALESCE(${workspaceBilling.plan} = 'pro' AND ${workspaceBilling.stripeProductKey} = ${PRO_STRIPE_PRODUCT_KEY}, false)`,
  );
}

export async function findOwnedHobbyWorkspace(
  userWorkosId: string,
  options: { db?: DbClient } = {},
) {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .leftJoin(workspaceBilling, eq(workspaceBilling.workspaceId, workspaces.id))
    .where(ownedHobbyWorkspaceFilter(userWorkosId))
    .limit(1);
  return rows[0] ?? null;
}

export async function countOwnedHobbyWorkspaces(
  userWorkosId: string,
  options: { db?: DbClient } = {},
): Promise<number> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ total: count() })
    .from(workspaces)
    .leftJoin(workspaceBilling, eq(workspaceBilling.workspaceId, workspaces.id))
    .where(ownedHobbyWorkspaceFilter(userWorkosId));
  return Number(rows[0]?.total ?? 0);
}

export async function markMcpSetupCompletedForUser(
  userWorkosId: string,
  options: { db?: DbClient; completedAt?: Date } = {},
) {
  const db = options.db ?? getDb();
  const completedAt = options.completedAt ?? new Date();
  await db
    .update(users)
    .set({ mcpSetupCompletedAt: completedAt, updatedAt: completedAt })
    .where(and(eq(users.workosUserId, userWorkosId), isNull(users.mcpSetupCompletedAt)));
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

// Creates the local resources for a user-created WorkOS organization: the
// workspace row, its creator membership, and the workspace's default wiki.
export async function createWorkspaceForUser(
  input: {
    workspaceId: string;
    workosOrganizationId: string;
    userWorkosId: string;
    name: string;
    slug?: string | null;
  },
  options: { db?: DbClient } = {},
): Promise<{ workspace: Workspace }> {
  const db = options.db ?? getDb();
  const name = input.name.trim();
  if (!name) throw new Error("Workspace name cannot be empty.");

  const workspaceValues = {
    id: input.workspaceId,
    workosOrganizationId: input.workosOrganizationId,
    name,
    slug: input.slug ?? null,
    createdByWorkosId: input.userWorkosId,
  };
  const membershipValues = {
    id: `goat_wsm_${randomUUID()}`,
    workspaceId: input.workspaceId,
    userWorkosId: input.userWorkosId,
    role: "admin" as const,
  };
  // Every workspace has exactly one default wiki, created atomically with it so
  // no entry point can ever resolve a workspace that has no wiki to write to.
  const defaultWikiValues = {
    id: newWikiId(),
    workspaceId: input.workspaceId,
    name: DEFAULT_WIKI_NAME,
    slug: DEFAULT_WIKI_SLUG,
    access: "workspace" as const,
    isDefault: true,
    createdByWorkosId: input.userWorkosId,
  };
  let workspace: Workspace | undefined;

  // neon-http exposes transactional batches but no interactive transactions;
  // the canonical API's node-postgres client exposes the inverse surface.
  if ("batch" in db) {
    const [workspaceRows] = await db.batch([
      db.insert(workspaces).values(workspaceValues).returning(),
      db.insert(workspaceMembers).values(membershipValues),
      db.insert(wikis).values(defaultWikiValues),
    ]);
    workspace = workspaceRows[0];
  } else {
    workspace = await db.transaction(async (tx: DbClient) => {
      const [workspace] = await tx.insert(workspaces).values(workspaceValues).returning();
      await tx.insert(workspaceMembers).values(membershipValues);
      await tx.insert(wikis).values(defaultWikiValues);
      if (!workspace) {
        throw new Error("Could not persist the opencompany workspace.");
      }
      return workspace;
    });
  }

  if (!workspace) throw new Error("Could not persist the opencompany workspace.");

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
      `Failed to grant the monthly Hobby allowance for opencompany workspace ${workspace.id}.`,
      error,
    );
  }

  return { workspace };
}

// Adopts local memberships for WorkOS organizations the user already belongs
// to (the invite-acceptance landing path). Organizations without a matching
// opencompany workspace row (e.g. web-app organizations in the shared WorkOS
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
  // Drop the member's restricted-wiki access in this workspace first, so
  // removal from the workspace cannot leave a readable wiki behind.
  await db.execute(sql`
    DELETE FROM goat.wiki_members wm
    USING goat.wikis w
    WHERE wm.wiki_id = w.id
      AND w.workspace_id = ${input.workspaceId}
      AND wm.user_workos_id = ${input.userWorkosId}
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

// The machine size new cloud coding sandboxes start on. Running sessions keep the
// size they were created with, so changing this only affects sessions created after.
export async function getWorkspaceSandboxSize(
  workspaceId: string,
  options: { db?: DbClient } = {},
): Promise<SandboxSize> {
  const db = options.db ?? getDb();
  const [workspace] = await db
    .select({ sandboxSize: workspaces.sandboxSize })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace?.sandboxSize ?? DEFAULT_SANDBOX_SIZE;
}

export async function updateWorkspaceSandboxSize(
  input: { workspaceId: string; sandboxSize: SandboxSize },
  options: { db?: DbClient } = {},
): Promise<SandboxSize> {
  const db = options.db ?? getDb();
  const [workspace] = await db
    .update(workspaces)
    .set({ sandboxSize: input.sandboxSize, updatedAt: new Date() })
    .where(eq(workspaces.id, input.workspaceId))
    .returning({ sandboxSize: workspaces.sandboxSize });
  if (!workspace) throw new Error("Workspace not found.");
  return workspace.sandboxSize;
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
