import { getDb } from "@opencompany/db/client";
import {
  type GoatBrain,
  type GoatWorkspace,
  type GoatWorkspaceRole,
  goatUsers,
} from "@opencompany/db/goat-schema";
import {
  adoptGoatWorkspaceMembershipsFromOrgs,
  createDefaultGoatWorkspaceForUser,
  DEFAULT_GOAT_BRAIN_SLUG,
  getGoatBrainAccess,
  type GoatWorkspaceWithRole,
  listAccessibleGoatBrains,
  listGoatWorkspacesForUser,
} from "@opencompany/db/goat-workspaces";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { User as WorkOSUser } from "@workos-inc/node";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getWorkOSClient } from "@/lib/workos-client";

export const GOAT_ACTIVE_WORKSPACE_COOKIE = "goat-active-workspace";
export const GOAT_ACTIVE_BRAIN_COOKIE = "goat-active-brain";

export type GoatAuthContext = {
  authUser: WorkOSUser;
  user: typeof goatUsers.$inferSelect;
  workspace: GoatWorkspace;
  role: GoatWorkspaceRole;
  brains: GoatBrain[];
  activeBrain: GoatBrain | null;
};

export async function syncGoatUser(authUser: WorkOSUser) {
  const db = getDb();
  const now = new Date();

  const [user] = await db
    .insert(goatUsers)
    .values({
      workosUserId: authUser.id,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      avatarUrl: authUser.profilePictureUrl,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: goatUsers.workosUserId,
      set: {
        email: authUser.email,
        firstName: authUser.firstName,
        lastName: authUser.lastName,
        avatarUrl: authUser.profilePictureUrl,
        updatedAt: now,
      },
    })
    .returning();

  if (!user) {
    throw new Error("Unable to sync the Goat user.");
  }

  return user;
}

function defaultWorkspaceName(user: typeof goatUsers.$inferSelect) {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const base = fullName || user.email.split("@")[0] || "My";
  return `${base}'s Workspace`;
}

// Adopts memberships for WorkOS organizations the user accepted an invitation
// to. Failures are swallowed: sign-in must not depend on WorkOS API health.
async function adoptWorkOSOrganizationMemberships(authUser: WorkOSUser) {
  try {
    const memberships = await getWorkOSClient().userManagement.listOrganizationMemberships({
      userId: authUser.id,
      statuses: ["active"],
    });
    await adoptGoatWorkspaceMembershipsFromOrgs({
      userWorkosId: authUser.id,
      memberships: memberships.data.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role?.slug === "admin" ? ("admin" as const) : ("member" as const),
      })),
    });
  } catch (error) {
    console.error("[goat] Failed to adopt WorkOS organization memberships", error);
  }
}

async function ensureGoatWorkspaces(
  authUser: WorkOSUser,
  user: typeof goatUsers.$inferSelect,
): Promise<GoatWorkspaceWithRole[]> {
  let workspaces = await listGoatWorkspacesForUser(user.workosUserId);
  if (workspaces.length > 0) return workspaces;

  await adoptWorkOSOrganizationMemberships(authUser);
  workspaces = await listGoatWorkspacesForUser(user.workosUserId);
  if (workspaces.length > 0) return workspaces;

  await createDefaultGoatWorkspaceForUser({
    userWorkosId: user.workosUserId,
    name: defaultWorkspaceName(user),
  });
  return listGoatWorkspacesForUser(user.workosUserId);
}

const resolveGoatAuthContext = cache(async (): Promise<GoatAuthContext | null> => {
  const session = await withAuth();
  if (!session.user) return null;

  const db = getDb();
  const [existingUser] = await db
    .select()
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, session.user.id))
    .limit(1);
  const user = existingUser ?? (await syncGoatUser(session.user));

  const workspaces = await ensureGoatWorkspaces(session.user, user);
  const first = workspaces[0];
  if (!first) return null;

  const cookieStore = await cookies();
  const requestedWorkspaceId = cookieStore.get(GOAT_ACTIVE_WORKSPACE_COOKIE)?.value;
  const active = workspaces.find((entry) => entry.workspace.id === requestedWorkspaceId) ?? first;

  const brains = await listAccessibleGoatBrains({
    userWorkosId: user.workosUserId,
    workspaceId: active.workspace.id,
  });
  const requestedBrainId = cookieStore.get(GOAT_ACTIVE_BRAIN_COOKIE)?.value;
  const activeBrain =
    brains.find((brain) => brain.id === requestedBrainId) ??
    brains.find((brain) => brain.slug === DEFAULT_GOAT_BRAIN_SLUG) ??
    brains[0] ??
    null;

  return {
    authUser: session.user,
    user,
    workspace: active.workspace,
    role: active.role,
    brains,
    activeBrain,
  };
});

export async function currentGoatUser(options: { optional: true }): Promise<GoatAuthContext | null>;
export async function currentGoatUser(options?: { optional?: false }): Promise<GoatAuthContext>;
export async function currentGoatUser(options: { optional?: boolean } = {}) {
  const context = await resolveGoatAuthContext();
  if (!context) {
    if (options.optional) return null;
    redirect("/auth/sign-in");
  }
  return context;
}

// The active brain, or a thrown error when the user cannot access any brain
// in the active workspace (e.g. every brain is restricted to other members).
export async function currentGoatBrain(): Promise<{ context: GoatAuthContext; brain: GoatBrain }> {
  const context = await currentGoatUser();
  if (!context.activeBrain) {
    throw new Error("You do not have access to any brain in this workspace.");
  }
  return { context, brain: context.activeBrain };
}

export async function currentGoatBrainByRef(
  brainRef: string,
): Promise<{ context: GoatAuthContext; brain: GoatBrain }> {
  const context = await currentGoatUser();
  const access = await getGoatBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) {
    throw new Error("You do not have access to that brain.");
  }
  return { context, brain: access.brain };
}
