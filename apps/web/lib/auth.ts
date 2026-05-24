import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  onboardingResponses,
  users,
  workspaceMemberships,
  workspaces,
} from "@opencompany/db/schema";
import { refreshSession, withAuth } from "@workos-inc/authkit-nextjs";
import type { User as WorkOSUser } from "@workos-inc/node";
import { and, eq, isNotNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";
import { grantDefaultSignupCreditForWorkspace } from "@/lib/billing/service";
import { getWorkOSClient } from "@/lib/workos";

type AppUser = typeof users.$inferSelect;
type AppWorkspace = typeof workspaces.$inferSelect;

const ADMIN_ROLE = "admin";
const MEMBER_ROLE = "member";

export type CurrentWorkspaceContext = {
  authUser: WorkOSUser;
  user: AppUser;
  workspace: AppWorkspace;
  isNewUser: boolean;
};

export const AUTHENTICATION_REQUIRED_MESSAGE = "Your session expired. Sign in again to continue.";

function appUserId(workosUserId: string) {
  return `usr_${workosUserId}`;
}

function newWorkspaceId() {
  return `wks_${randomUUID()}`;
}

function displayName(user: WorkOSUser) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email.split("@")[0] || "Workspace";
}

function defaultWorkspaceName(user: WorkOSUser) {
  return `${displayName(user)}'s Workspace`;
}

function normalizeMembershipRole(role?: string | null) {
  return role === ADMIN_ROLE ? ADMIN_ROLE : MEMBER_ROLE;
}

async function syncUser(authUser: WorkOSUser) {
  const db = getDb();
  const now = new Date();
  const userId = appUserId(authUser.id);
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.workosUserId, authUser.id))
    .limit(1);
  const isNewUser = !existingUser;

  const [user] = await db
    .insert(users)
    .values({
      id: userId,
      workosUserId: authUser.id,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      avatarUrl: authUser.profilePictureUrl,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.workosUserId,
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
    throw new Error("Unable to sync the current user.");
  }

  return { user, isNewUser };
}

async function syncLocalMembership(input: { workspaceId: string; userId: string; role: string }) {
  const db = getDb();
  const now = new Date();

  await db
    .insert(workspaceMemberships)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      set: {
        role: input.role,
        updatedAt: now,
      },
    });
}

export async function loadCurrentWorkspaceContextReadOnly(
  authUser: WorkOSUser,
  organizationId: string,
): Promise<CurrentWorkspaceContext | null> {
  const db = getDb();
  const [userRows, workspaceRows] = await Promise.all([
    db.select().from(users).where(eq(users.workosUserId, authUser.id)).limit(1),
    db
      .select()
      .from(workspaces)
      .where(eq(workspaces.workosOrganizationId, organizationId))
      .limit(1),
  ]);
  const user = userRows[0];
  const workspace = workspaceRows[0];

  if (!user || !workspace) return null;

  const [membership] = await db
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspace.id),
        eq(workspaceMemberships.userId, user.id),
      ),
    )
    .limit(1);

  if (!membership) return null;

  return {
    authUser,
    user,
    workspace,
    isNewUser: false,
  };
}

export async function syncUserAndWorkspace(
  authUser: WorkOSUser,
  organizationId: string,
  role?: string | null,
): Promise<CurrentWorkspaceContext> {
  const db = getDb();
  const now = new Date();
  const { user, isNewUser } = await syncUser(authUser);

  const [existingWorkspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.workosOrganizationId, organizationId))
    .limit(1);

  let workspace = existingWorkspace;
  let createdWorkspaceForNewUser = false;

  if (!workspace) {
    const organization = await getWorkOSClient().organizations.getOrganization(organizationId);
    const [createdWorkspace] = await db
      .insert(workspaces)
      .values({
        id: newWorkspaceId(),
        workosOrganizationId: organization.id,
        name: organization.name || defaultWorkspaceName(authUser),
        createdByUserId: user.id,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    workspace =
      createdWorkspace ??
      (
        await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.workosOrganizationId, organizationId))
          .limit(1)
      )[0];
    createdWorkspaceForNewUser = Boolean(createdWorkspace) && isNewUser;
  }

  if (!workspace) {
    throw new Error("Unable to load the current workspace.");
  }

  if (createdWorkspaceForNewUser) {
    await grantDefaultSignupCreditForWorkspace({
      workspaceId: workspace.id,
      userId: user.id,
    });
  }

  await syncLocalMembership({
    workspaceId: workspace.id,
    userId: user.id,
    role: normalizeMembershipRole(role),
  });

  return {
    authUser,
    user,
    workspace,
    isNewUser,
  };
}

export async function provisionDefaultOrganization(
  authUser: WorkOSUser,
): Promise<CurrentWorkspaceContext> {
  const db = getDb();
  const now = new Date();
  const { user, isNewUser } = await syncUser(authUser);

  const [existingWorkspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.createdByUserId, user.id), isNotNull(workspaces.workosOrganizationId)))
    .limit(1);

  if (existingWorkspace?.workosOrganizationId) {
    await syncLocalMembership({
      workspaceId: existingWorkspace.id,
      userId: user.id,
      role: ADMIN_ROLE,
    });

    return {
      authUser,
      user,
      workspace: existingWorkspace,
      isNewUser,
    };
  }

  const organization = await getWorkOSClient().organizations.createOrganization({
    name: defaultWorkspaceName(authUser),
  });

  await getWorkOSClient().userManagement.createOrganizationMembership({
    organizationId: organization.id,
    userId: authUser.id,
    roleSlug: ADMIN_ROLE,
  });

  const [workspace] = await db
    .insert(workspaces)
    .values({
      id: newWorkspaceId(),
      workosOrganizationId: organization.id,
      name: organization.name || defaultWorkspaceName(authUser),
      createdByUserId: user.id,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  const currentWorkspace =
    workspace ??
    (
      await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.workosOrganizationId, organization.id))
        .limit(1)
    )[0];

  if (!currentWorkspace) {
    throw new Error("Unable to create the default workspace.");
  }

  if (workspace && isNewUser) {
    await grantDefaultSignupCreditForWorkspace({
      workspaceId: currentWorkspace.id,
      userId: user.id,
    });
  }

  await syncLocalMembership({
    workspaceId: currentWorkspace.id,
    userId: user.id,
    role: ADMIN_ROLE,
  });

  return {
    authUser,
    user,
    workspace: currentWorkspace,
    isNewUser,
  };
}

export async function refreshIntoWorkspaceOrganization(workspace: AppWorkspace) {
  if (!workspace.workosOrganizationId) {
    throw new Error("Workspace is not linked to a WorkOS Organization.");
  }

  await refreshSession({
    organizationId: workspace.workosOrganizationId,
    ensureSignedIn: true,
  });
}

export async function hasCompletedOnboarding(userId: string) {
  const db = getDb();
  const [response] = await db
    .select({ userId: onboardingResponses.userId })
    .from(onboardingResponses)
    .where(eq(onboardingResponses.userId, userId))
    .limit(1);

  return Boolean(response);
}

export const getOptionalCurrentWorkspaceWithoutOnboarding = cache(async () => {
  const session = await withAuth();

  if (!session.user || !session.organizationId) {
    return null;
  }

  return (
    (await loadCurrentWorkspaceContextReadOnly(session.user, session.organizationId)) ??
    (await syncUserAndWorkspace(
      session.user,
      session.organizationId,
      session.role ?? session.roles?.[0],
    ))
  );
});

export const getCurrentWorkspaceWithoutOnboarding = cache(async () => {
  const session = await withAuth({ ensureSignedIn: true });

  if (!session.organizationId) {
    redirect("/auth/organization");
  }

  return (
    (await loadCurrentWorkspaceContextReadOnly(session.user, session.organizationId)) ??
    (await syncUserAndWorkspace(
      session.user,
      session.organizationId,
      session.role ?? session.roles?.[0],
    ))
  );
});

export const getOptionalCurrentWorkspace = cache(async () => {
  const context = await getOptionalCurrentWorkspaceWithoutOnboarding();

  if (!context) {
    return null;
  }

  if (!(await hasCompletedOnboarding(context.user.id))) {
    redirect("/onboarding");
  }

  return context;
});

export const getCurrentWorkspace = cache(async () => {
  const context = await getCurrentWorkspaceWithoutOnboarding();

  if (!(await hasCompletedOnboarding(context.user.id))) {
    redirect("/onboarding");
  }

  return context;
});

export async function requireCurrentWorkspace() {
  const context = await getOptionalCurrentWorkspace();

  if (!context) {
    redirect("/signup");
  }

  return context;
}
