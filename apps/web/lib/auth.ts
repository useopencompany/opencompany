import { cache } from "react";
import { redirect } from "next/navigation";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { eq } from "drizzle-orm";
import type { User as WorkOSUser } from "@workos-inc/node";
import { getDb } from "@opencompany/db/client";
import {
  onboardingResponses,
  users,
  workspaces,
  workspaceMemberships,
} from "@opencompany/db/schema";

type AppUser = typeof users.$inferSelect;
type AppWorkspace = typeof workspaces.$inferSelect;

export type CurrentWorkspaceContext = {
  authUser: WorkOSUser;
  user: AppUser;
  workspace: AppWorkspace;
  isNewUser: boolean;
};

function appUserId(workosUserId: string) {
  return `usr_${workosUserId}`;
}

function defaultWorkspaceId(userId: string) {
  return `wks_${userId}`;
}

function displayName(user: WorkOSUser) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email.split("@")[0] || "Workspace";
}

function defaultWorkspaceName(user: WorkOSUser) {
  return `${displayName(user)}'s Workspace`;
}

export async function syncUserAndWorkspace(
  authUser: WorkOSUser,
): Promise<CurrentWorkspaceContext> {
  const db = getDb();
  const now = new Date();
  const userId = appUserId(authUser.id);
  const workspaceId = defaultWorkspaceId(userId);
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

  const [workspace] = await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name: defaultWorkspaceName(authUser),
      createdByUserId: user.id,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  await db
    .insert(workspaceMemberships)
    .values({
      workspaceId,
      userId: user.id,
      role: "owner",
      updatedAt: now,
    })
    .onConflictDoNothing();

  const currentWorkspace =
    workspace ??
    (
      await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
    )[0];

  if (!currentWorkspace) {
    throw new Error("Unable to load the default workspace.");
  }

  return {
    authUser,
    user,
    workspace: currentWorkspace,
    isNewUser,
  };
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

  if (!session.user) {
    return null;
  }

  return syncUserAndWorkspace(session.user);
});

export const getCurrentWorkspaceWithoutOnboarding = cache(async () => {
  const session = await withAuth({ ensureSignedIn: true });
  return syncUserAndWorkspace(session.user);
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
