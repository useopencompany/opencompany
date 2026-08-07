import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { type Brain, users, type Workspace, type WorkspaceRole } from "@opencompany/db/schema";
import {
  adoptWorkspaceMembershipsFromOrgs,
  createDefaultWorkspaceForUser,
  DEFAULT_BRAIN_SLUG,
  getBrainAccess,
  listAccessibleBrains,
  listWorkspacesForUser,
  type WorkspaceWithRole,
} from "@opencompany/db/workspaces";
import { recordSignup } from "@opencompany/telemetry";
import { saveSession, withAuth } from "@workos-inc/authkit-nextjs";
import type { AuthenticationResponse, User as WorkOSUser } from "@workos-inc/node";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { cache } from "react";
import { recordLastAuthMethod } from "@/lib/auth-methods";
import { syncStripeSeatQuantityForWorkspace } from "@/lib/billing/seats";
import { enrollOwnerInOnboardingEmails } from "@/lib/email/onboarding-emails";
import { getWorkOSClient } from "@/lib/workos-client";
import { ensureWorkspaceOrganizationsForEntries } from "@/lib/workos-organizations";

export const ACTIVE_WORKSPACE_COOKIE = "goat-active-workspace";
export const ACTIVE_BRAIN_COOKIE = "goat-active-brain";

export type AuthContext = {
  authUser: WorkOSUser;
  user: typeof users.$inferSelect;
  workspace: Workspace;
  role: WorkspaceRole;
  workspaces: WorkspaceWithRole[];
  brains: Brain[];
  activeBrain: Brain | null;
};

export async function syncUser(authUser: WorkOSUser) {
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
    .insert(users)
    .values(values)
    .onConflictDoNothing({ target: users.workosUserId })
    .returning();

  if (insertedUser) {
    recordSignup({ source: "user_sync" });
    await captureServerEvent(
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
    .update(users)
    .set({
      email: values.email,
      firstName: values.firstName,
      lastName: values.lastName,
      avatarUrl: values.avatarUrl,
      updatedAt: values.updatedAt,
    })
    .where(eq(users.workosUserId, authUser.id))
    .returning();

  if (!updatedUser) {
    throw new Error("Unable to sync the user.");
  }

  return updatedUser;
}

function defaultWorkspaceName(user: typeof users.$inferSelect) {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const base = fullName || user.email.split("@")[0] || "My";
  return `${base}'s Workspace`;
}

// Reconciles memberships for WorkOS organizations the user accepted an
// invitation to. Authentication calls this even when the user already has a
// personal workspace; otherwise that existing membership hides newly accepted
// workspace invitations. Failures are swallowed: sign-in must not depend on
// WorkOS API health.
export async function adoptWorkOSOrganizationMemberships(authUser: WorkOSUser) {
  try {
    const memberships = await getWorkOSClient().userManagement.listOrganizationMemberships({
      userId: authUser.id,
      statuses: ["active"],
    });
    const adopted = await adoptWorkspaceMembershipsFromOrgs({
      userWorkosId: authUser.id,
      memberships: memberships.data.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role?.slug === "admin" ? ("admin" as const) : ("member" as const),
      })),
    });
    if (adopted > 0) {
      const workspaces = await listWorkspacesForUser(authUser.id);
      await Promise.all(
        workspaces.map((entry) =>
          syncStripeSeatQuantityForWorkspace(entry.workspace.id).catch((error) => {
            console.error("[app] Failed to sync Stripe seat quantity after invite adoption", error);
          }),
        ),
      );
    }
  } catch (error) {
    console.error("[app] Failed to adopt WorkOS organization memberships", error);
  }
}

export async function activateWorkspaceForOrganization(input: {
  userWorkosId: string;
  organizationId: string;
}): Promise<boolean> {
  const workspaces = await listWorkspacesForUser(input.userWorkosId);
  const target = workspaces.find(
    (entry) => entry.workspace.workosOrganizationId === input.organizationId,
  );
  if (!target) return false;

  const brains = await listAccessibleBrains({
    userWorkosId: input.userWorkosId,
    workspaceId: target.workspace.id,
  });
  const activeBrain =
    brains.find((brain) => brain.slug === DEFAULT_BRAIN_SLUG) ?? brains[0] ?? null;

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, target.workspace.id, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  if (activeBrain) {
    cookieStore.set(ACTIVE_BRAIN_COOKIE, activeBrain.id, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  } else {
    cookieStore.delete(ACTIVE_BRAIN_COOKIE);
  }

  return true;
}

// Shared by both custom sign-in surfaces (Google OAuth callback and the magic-link
// server action): seals the WorkOS session into the same cookie withAuth() reads,
// then runs the same sync/adopt/activate side effects the old hosted-AuthKit
// onSuccess callback used to run.
export async function completeAuthentication(
  authResponse: AuthenticationResponse,
  request: NextRequest | string,
) {
  await saveSession(authResponse, request);
  await recordLastAuthMethod(authResponse.authenticationMethod);
  await syncUser(authResponse.user);
  await adoptWorkOSOrganizationMemberships(authResponse.user);
  if (authResponse.organizationId) {
    try {
      await activateWorkspaceForOrganization({
        userWorkosId: authResponse.user.id,
        organizationId: authResponse.organizationId,
      });
    } catch (error) {
      console.error("[app] Failed to activate the authenticated workspace", error);
    }
  }
}

async function ensureWorkspaces(
  authUser: WorkOSUser,
  user: typeof users.$inferSelect,
): Promise<WorkspaceWithRole[]> {
  let workspaces = await listWorkspacesForUser(user.workosUserId);
  if (workspaces.length > 0) return ensureWorkspaceOrganizationsForEntries(workspaces);

  await adoptWorkOSOrganizationMemberships(authUser);
  workspaces = await listWorkspacesForUser(user.workosUserId);
  if (workspaces.length > 0) return ensureWorkspaceOrganizationsForEntries(workspaces);

  await createDefaultWorkspaceForUser({
    userWorkosId: user.workosUserId,
    name: defaultWorkspaceName(user),
  });
  // A user only reaches this branch when we create their own workspace (invited
  // members return above), so this is the "brand-new owner" moment. Enroll them
  // in the founder onboarding email drip and fire the welcome immediately.
  // Best-effort: email/DB hiccups must never block sign-in.
  await enrollOwnerInOnboardingEmails({ workosUserId: user.workosUserId }).catch((error) => {
    console.error("[app] Failed to enroll owner in onboarding emails", error);
  });
  workspaces = await listWorkspacesForUser(user.workosUserId);
  return ensureWorkspaceOrganizationsForEntries(workspaces);
}

const resolveAuthContext = cache(async (): Promise<AuthContext | null> => {
  const session = await withAuth();
  if (!session.user) return null;

  const db = getDb();
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.workosUserId, session.user.id))
    .limit(1);
  const user = existingUser ?? (await syncUser(session.user));

  const workspaces = await ensureWorkspaces(session.user, user);
  const first = workspaces[0];
  if (!first) return null;

  const cookieStore = await cookies();
  const requestedWorkspaceId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const active =
    workspaces.find(
      (entry) =>
        session.organizationId && entry.workspace.workosOrganizationId === session.organizationId,
    ) ??
    workspaces.find((entry) => entry.workspace.id === requestedWorkspaceId) ??
    first;

  const brains = await listAccessibleBrains({
    userWorkosId: user.workosUserId,
    workspaceId: active.workspace.id,
  });
  const requestedBrainId = cookieStore.get(ACTIVE_BRAIN_COOKIE)?.value;
  const activeBrain =
    brains.find((brain) => brain.id === requestedBrainId) ??
    brains.find((brain) => brain.slug === DEFAULT_BRAIN_SLUG) ??
    brains[0] ??
    null;

  return {
    authUser: session.user,
    user,
    workspace: active.workspace,
    role: active.role,
    workspaces,
    brains,
    activeBrain,
  };
});

export async function currentUser(options: { optional: true }): Promise<AuthContext | null>;
export async function currentUser(options?: { optional?: false }): Promise<AuthContext>;
export async function currentUser(options: { optional?: boolean } = {}) {
  const context = await resolveAuthContext();
  if (!context) {
    if (options.optional) return null;
    redirect("/signin");
  }
  return context;
}

// The active brain, or a thrown error when the user cannot access any brain
// in the active workspace (e.g. every brain is restricted to other members).
export async function currentBrain(): Promise<{ context: AuthContext; brain: Brain }> {
  const context = await currentUser();
  if (!context.activeBrain) {
    throw new Error("You do not have access to any brain in this workspace.");
  }
  return { context, brain: context.activeBrain };
}

export async function currentBrainByRef(
  brainRef: string,
): Promise<{ context: AuthContext; brain: Brain }> {
  const context = await currentUser();
  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) {
    throw new Error("You do not have access to that brain.");
  }
  return { context, brain: access.brain };
}
