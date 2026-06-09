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
import { isPersonalFirst } from "@/lib/flags/personalFirst";
import { getWorkOSClient } from "@/lib/workos";

// Workspace auth is a small data access layer: one request-memoized resolver loads
// the WorkOS session and local workspace context, while currentWorkspace() applies
// route policy such as optional access, onboarding, or admin-only authorization.
// Unauthenticated users (no session or no organization) are redirected to /signup
// to keep the acquisition funnel intact; route handlers opt into anonymous access
// via { optional: true }.
type AppUser = typeof users.$inferSelect;
type AppWorkspace = typeof workspaces.$inferSelect;
type OnboardingUser = Pick<AppUser, "id" | "email">;

const ADMIN_ROLE = "admin";
const MEMBER_ROLE = "member";
type WorkspaceRole = typeof ADMIN_ROLE | typeof MEMBER_ROLE;

export type CurrentWorkspaceContext = {
  authUser: WorkOSUser;
  user: AppUser;
  workspace: AppWorkspace;
  role: WorkspaceRole;
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

function normalizeMembershipRole(role?: string | null): WorkspaceRole {
  return role === ADMIN_ROLE ? ADMIN_ROLE : MEMBER_ROLE;
}

function isLocalDevelopmentRuntime() {
  return (
    process.env.NODE_ENV !== "production" && process.env.CI !== "true" && !process.env.VERCEL_ENV
  );
}

function localOnboardingBypassEmails() {
  return new Set(
    (process.env.OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function shouldBypassOnboarding(user: OnboardingUser) {
  return isLocalDevelopmentRuntime() && localOnboardingBypassEmails().has(user.email.toLowerCase());
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
  // One joined read instead of (user ∥ workspace) then membership: the membership row
  // links the WorkOS-identified user to the WorkOS-identified workspace, so a single
  // round-trip resolves the whole context. A missing user, workspace, or membership
  // yields no row, which keeps the prior "return null → sync" fallback semantics.
  const [row] = await db
    .select({ user: users, workspace: workspaces, role: workspaceMemberships.role })
    .from(users)
    .innerJoin(workspaceMemberships, eq(workspaceMemberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(eq(users.workosUserId, authUser.id), eq(workspaces.workosOrganizationId, organizationId)),
    )
    .limit(1);

  if (!row) return null;

  return {
    authUser,
    user: row.user,
    workspace: row.workspace,
    role: normalizeMembershipRole(row.role),
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
    role: normalizeMembershipRole(role),
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
      role: ADMIN_ROLE,
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
    role: ADMIN_ROLE,
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

export async function hasCompletedOnboarding(user: string | OnboardingUser) {
  if (typeof user !== "string" && shouldBypassOnboarding(user)) {
    return true;
  }

  const userId = typeof user === "string" ? user : user.id;
  const db = getDb();
  const [response] = await db
    .select({ userId: onboardingResponses.userId })
    .from(onboardingResponses)
    .where(eq(onboardingResponses.userId, userId))
    .limit(1);

  return Boolean(response);
}

const hasCompletedOnboardingForUser = cache(hasCompletedOnboarding);

const resolveWorkspaceContext = cache(async () => {
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

type CurrentWorkspaceOptions = {
  optional?: boolean;
  skipOnboarding?: boolean;
  requireAdmin?: boolean;
};

type OptionalCurrentWorkspaceOptions = CurrentWorkspaceOptions & {
  optional: true;
};

export function currentWorkspace(
  options: OptionalCurrentWorkspaceOptions,
): Promise<CurrentWorkspaceContext | null>;
export function currentWorkspace(
  options?: CurrentWorkspaceOptions,
): Promise<CurrentWorkspaceContext>;
export async function currentWorkspace(options: CurrentWorkspaceOptions = {}) {
  const context = await resolveWorkspaceContext();

  if (!context) {
    if (options.optional) return null;
    redirect("/signup");
  }

  if (!options.skipOnboarding && !(await hasCompletedOnboardingForUser(context.user))) {
    // Personal-first users get the personal onboarding chatbox; company-first users get the
    // legacy onboarding form.
    redirect(isPersonalFirst(context.user) ? "/onboarding/personal" : "/onboarding");
  }

  if (options.requireAdmin && context.role !== ADMIN_ROLE) {
    throw new Error("Only workspace admins can perform this action.");
  }

  return context;
}
