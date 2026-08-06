import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import { getDb } from "@opencompany/db/client";
import {
  type GoatBrain,
  type GoatWorkspace,
  type GoatWorkspaceRole,
  goatUsers,
} from "@opencompany/db/goat-schema";
import {
  adoptGoatWorkspaceMembershipsFromOrgs,
  DEFAULT_GOAT_BRAIN_SLUG,
  type GoatWorkspaceWithRole,
  getGoatBrainAccess,
  listAccessibleGoatBrains,
  listGoatWorkspacesForUser,
} from "@opencompany/db/goat-workspaces";
import { recordGoatSignup } from "@opencompany/goat-observability";
import { saveSession, withAuth } from "@workos-inc/authkit-nextjs";
import type { AuthenticationResponse, User as WorkOSUser } from "@workos-inc/node";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { cache } from "react";
import { recordLastGoatAuthMethod } from "@/lib/auth-methods";
import { syncGoatStripeSeatQuantityForWorkspace } from "@/lib/billing/seats";
import { getWorkOSClient } from "@/lib/workos-client";
import { ensureGoatWorkspaceOrganizationsForEntries } from "@/lib/workos-organizations";
import {
  GOAT_ACTIVE_BRAIN_COOKIE,
  GOAT_ACTIVE_WORKSPACE_COOKIE,
  rememberActiveGoatWorkspace,
} from "@/lib/workspace-session";

export { GOAT_ACTIVE_BRAIN_COOKIE, GOAT_ACTIVE_WORKSPACE_COOKIE };

export type GoatIdentityContext = {
  authUser: WorkOSUser;
  organizationId: string | null;
  user: typeof goatUsers.$inferSelect;
  workspaces: GoatWorkspaceWithRole[];
};

export type GoatAuthContext = {
  authUser: WorkOSUser;
  user: typeof goatUsers.$inferSelect;
  workspace: GoatWorkspace;
  role: GoatWorkspaceRole;
  workspaces: GoatWorkspaceWithRole[];
  brains: GoatBrain[];
  activeBrain: GoatBrain | null;
};

export async function syncGoatUser(authUser: WorkOSUser) {
  const db = getDb();
  const now = new Date();
  const values = {
    workosUserId: authUser.id,
    email: authUser.email,
    firstName: authUser.firstName,
    lastName: authUser.lastName,
    avatarUrl: authUser.profilePictureUrl,
    updatedAt: now,
  };

  const [insertedUser] = await db
    .insert(goatUsers)
    .values(values)
    .onConflictDoNothing({ target: goatUsers.workosUserId })
    .returning();

  if (insertedUser) {
    recordGoatSignup({ source: "user_sync" });
    await captureGoatServerEvent(
      "signup_completed",
      insertedUser.workosUserId,
      {
        source: "user_sync",
      },
      {
        email: insertedUser.email,
        firstName: insertedUser.firstName,
        lastName: insertedUser.lastName,
      },
    );
    return insertedUser;
  }

  const [updatedUser] = await db
    .update(goatUsers)
    .set({
      email: values.email,
      firstName: values.firstName,
      lastName: values.lastName,
      avatarUrl: values.avatarUrl,
      updatedAt: values.updatedAt,
    })
    .where(eq(goatUsers.workosUserId, authUser.id))
    .returning();

  if (!updatedUser) {
    throw new Error("Unable to sync the Goat user.");
  }

  return updatedUser;
}

// Reconciles memberships for WorkOS organizations the user accepted an
// invitation to. Authentication calls this even when the user already has a
// workspace; otherwise existing local membership can hide newly accepted
// invitations. Failures are swallowed: sign-in must not depend on WorkOS API
// health.
export async function adoptWorkOSOrganizationMemberships(authUser: WorkOSUser) {
  try {
    const memberships = await getWorkOSClient().userManagement.listOrganizationMemberships({
      userId: authUser.id,
      statuses: ["active"],
    });
    const adopted = await adoptGoatWorkspaceMembershipsFromOrgs({
      userWorkosId: authUser.id,
      memberships: memberships.data.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role?.slug === "admin" ? ("admin" as const) : ("member" as const),
      })),
    });
    if (adopted > 0) {
      const workspaces = await listGoatWorkspacesForUser(authUser.id);
      await Promise.all(
        workspaces.map((entry) =>
          syncGoatStripeSeatQuantityForWorkspace(entry.workspace.id).catch((error) => {
            console.error(
              "[goat] Failed to sync Stripe seat quantity after invite adoption",
              error,
            );
          }),
        ),
      );
    }
  } catch (error) {
    console.error("[goat] Failed to adopt WorkOS organization memberships", error);
  }
}

export async function activateGoatWorkspaceForOrganization(input: {
  userWorkosId: string;
  organizationId: string;
}): Promise<boolean> {
  const workspaces = await listGoatWorkspacesForUser(input.userWorkosId);
  const target = workspaces.find(
    (entry) => entry.workspace.workosOrganizationId === input.organizationId,
  );
  if (!target) return false;

  const brains = await listAccessibleGoatBrains({
    userWorkosId: input.userWorkosId,
    workspaceId: target.workspace.id,
  });
  const activeBrain =
    brains.find((brain) => brain.slug === DEFAULT_GOAT_BRAIN_SLUG) ?? brains[0] ?? null;

  await rememberActiveGoatWorkspace({
    workspaceId: target.workspace.id,
    brainId: activeBrain?.id ?? null,
  });

  return true;
}

// Shared by both custom sign-in surfaces (Google OAuth callback and the magic-link
// server action): seals the WorkOS session into the same cookie withAuth() reads,
// then runs the same sync/adopt/activate side effects the old hosted-AuthKit
// onSuccess callback used to run.
export async function completeGoatAuthentication(
  authResponse: AuthenticationResponse,
  request: NextRequest | string,
) {
  await saveSession(authResponse, request);
  await recordLastGoatAuthMethod(authResponse.authenticationMethod);
  await syncGoatUser(authResponse.user);
  await adoptWorkOSOrganizationMemberships(authResponse.user);
  if (authResponse.organizationId) {
    try {
      await activateGoatWorkspaceForOrganization({
        userWorkosId: authResponse.user.id,
        organizationId: authResponse.organizationId,
      });
    } catch (error) {
      console.error("[goat] Failed to activate the authenticated workspace", error);
    }
  }
}

// Authentication and workspace provisioning are separate product states. A
// newly authenticated owner legitimately has zero workspaces until the
// onboarding workspace step creates one; invited users receive memberships in
// completeGoatAuthentication() before this resolver runs.
const resolveGoatIdentity = cache(async (): Promise<GoatIdentityContext | null> => {
  const session = await withAuth();
  if (!session.user) return null;

  const db = getDb();
  const [existingUser] = await db
    .select()
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, session.user.id))
    .limit(1);
  const user = existingUser ?? (await syncGoatUser(session.user));
  let accessibleWorkspaces = await listGoatWorkspacesForUser(user.workosUserId);
  if (accessibleWorkspaces.length === 0 && session.organizationId) {
    // The auth callback normally adopts invitations. Retry only when AuthKit
    // selected an organization but no local membership is visible, covering a
    // transient callback-side WorkOS/DB failure without penalizing new owners.
    await adoptWorkOSOrganizationMemberships(session.user);
    accessibleWorkspaces = await listGoatWorkspacesForUser(user.workosUserId);
  }
  const workspaces = await ensureGoatWorkspaceOrganizationsForEntries(accessibleWorkspaces);

  return {
    authUser: session.user,
    organizationId: session.organizationId ?? null,
    user,
    workspaces,
  };
});

const resolveGoatAuthContext = cache(async (): Promise<GoatAuthContext | null> => {
  const identity = await resolveGoatIdentity();
  if (!identity) return null;

  const first = identity.workspaces[0];
  if (!first) return null;

  const cookieStore = await cookies();
  const requestedWorkspaceId = cookieStore.get(GOAT_ACTIVE_WORKSPACE_COOKIE)?.value;
  const active =
    identity.workspaces.find(
      (entry) =>
        identity.organizationId && entry.workspace.workosOrganizationId === identity.organizationId,
    ) ??
    identity.workspaces.find((entry) => entry.workspace.id === requestedWorkspaceId) ??
    first;

  const brains = await listAccessibleGoatBrains({
    userWorkosId: identity.user.workosUserId,
    workspaceId: active.workspace.id,
  });
  const requestedBrainId = cookieStore.get(GOAT_ACTIVE_BRAIN_COOKIE)?.value;
  const activeBrain =
    brains.find((brain) => brain.id === requestedBrainId) ??
    brains.find((brain) => brain.slug === DEFAULT_GOAT_BRAIN_SLUG) ??
    brains[0] ??
    null;

  return {
    authUser: identity.authUser,
    user: identity.user,
    workspace: active.workspace,
    role: active.role,
    workspaces: identity.workspaces,
    brains,
    activeBrain,
  };
});

export async function currentGoatIdentity(options: {
  optional: true;
}): Promise<GoatIdentityContext | null>;
export async function currentGoatIdentity(options?: {
  optional?: false;
}): Promise<GoatIdentityContext>;
export async function currentGoatIdentity(options: { optional?: boolean } = {}) {
  const identity = await resolveGoatIdentity();
  if (!identity) {
    if (options.optional) return null;
    redirect("/signin");
  }
  return identity;
}

export async function currentGoatUser(options: { optional: true }): Promise<GoatAuthContext | null>;
export async function currentGoatUser(options?: { optional?: false }): Promise<GoatAuthContext>;
export async function currentGoatUser(options: { optional?: boolean } = {}) {
  const identity = await resolveGoatIdentity();
  if (!identity) {
    if (options.optional) return null;
    redirect("/signin");
  }
  const context = await resolveGoatAuthContext();
  if (!context) {
    if (options.optional) return null;
    redirect("/onboarding");
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
