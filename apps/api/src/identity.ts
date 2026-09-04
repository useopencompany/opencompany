import { ensureWorkspaceOrganizationsForEntries } from "@opencompany/agent/workspaces/organizations";
import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import { syncStripeSeatQuantityForWorkspace } from "@opencompany/billing/seats";
import { type User, users } from "@opencompany/db/product-schema";
import {
  adoptWorkspaceMembershipsFromOrgs,
  DEFAULT_BRAIN_SLUG,
  listAccessibleBrains,
  listWorkspacesForUser,
} from "@opencompany/db/workspaces";
import { createLogger } from "@opencompany/observability";
import type { IdentityDto } from "@opencompany/protocol";
import { recordSignup } from "@opencompany/telemetry";
import type { WorkOS, User as WorkOSUser } from "@workos-inc/node";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { ApiIdentity } from "./auth";

type DbLike = any;

const logger = createLogger({ service: "opencompany-api", runtime: "identity" });

export type IdentityService = {
  get(identity: ApiIdentity): Promise<IdentityDto>;
  sync(identity: ApiIdentity): Promise<IdentityDto>;
};

export function createIdentityService(input: {
  db: DbLike;
  workos: WorkOS;
  stripe?: Stripe;
}): IdentityService {
  const { db, workos } = input;

  async function syncUser(authUser: WorkOSUser): Promise<User> {
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
      await captureProductServerEvent(
        "signup_completed",
        insertedUser.workosUserId,
        { source: "user_sync" },
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
    if (!updatedUser) throw new Error("Unable to sync the opencompany user.");
    return updatedUser;
  }

  async function adoptMemberships(userId: string) {
    try {
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId,
        statuses: ["active"],
      });
      const adopted = await adoptWorkspaceMembershipsFromOrgs(
        {
          userWorkosId: userId,
          memberships: memberships.data.map((membership) => ({
            organizationId: membership.organizationId,
            role: membership.role?.slug === "admin" ? ("admin" as const) : ("member" as const),
          })),
        },
        { db },
      );
      if (adopted === 0) return;
      const workspaces = await listWorkspacesForUser(userId, { db });
      await Promise.all(
        workspaces.map((entry) =>
          syncStripeSeatQuantityForWorkspace(entry.workspace.id, {
            db,
            ...(input.stripe ? { stripe: input.stripe } : {}),
          }).catch((error) => {
            logger.warn("Stripe seat sync failed after identity membership adoption", {
              event: "opencompany.api_identity_seat_sync_failed",
              workspace_id: entry.workspace.id,
              error_name: error instanceof Error ? error.name : typeof error,
            });
          }),
        ),
      );
    } catch (error) {
      // Sign-in must not depend on WorkOS membership-list availability. A later
      // identity read retries adoption when the selected organization is absent.
      logger.warn("Identity membership adoption unavailable", {
        event: "opencompany.api_identity_membership_adoption_failed",
        user_id: userId,
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  async function resolve(identity: ApiIdentity, user: User): Promise<IdentityDto> {
    let accessibleWorkspaces = await listWorkspacesForUser(identity.userId, { db });
    if (accessibleWorkspaces.length === 0 && identity.organizationId) {
      await adoptMemberships(identity.userId);
      accessibleWorkspaces = await listWorkspacesForUser(identity.userId, { db });
    }
    const workspaces = await ensureWorkspaceOrganizationsForEntries(accessibleWorkspaces, {
      workos,
      db,
    });
    const isOrganizationlessBearer =
      identity.credentialKind !== "browser_cookie" && !identity.organizationId;
    const first = workspaces[0];
    const active =
      !isOrganizationlessBearer && first
        ? (workspaces.find(
            (entry) =>
              identity.organizationId &&
              entry.workspace.workosOrganizationId === identity.organizationId,
          ) ??
          workspaces.find((entry) => entry.workspace.id === identity.activeWorkspaceId) ??
          first)
        : null;
    const brains = active?.workspace.legacyBrainEnabled
      ? await listAccessibleBrains(
          { userWorkosId: identity.userId, workspaceId: active.workspace.id },
          { db },
        )
      : [];
    const activeBrain =
      brains.find((brain) => brain.id === identity.activeBrainId) ??
      brains.find((brain) => brain.slug === DEFAULT_BRAIN_SLUG) ??
      brains[0] ??
      null;

    return {
      user: {
        id: user.workosUserId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        timezone: user.timezone,
        taskSpawningEnabled: user.taskSpawningEnabled,
        autoModelRoutingEnabled: user.autoModelRoutingEnabled,
        chatCapabilitiesBetaEnabled: user.chatCapabilitiesBetaEnabled,
        wikiEnabled: true as const,
        taskViewMode: user.taskViewMode,
        preferredMcpClient: user.preferredMcpClient,
        mcpSetupCompletedAt: user.mcpSetupCompletedAt?.toISOString() ?? null,
        onboardedAt: user.onboardedAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      },
      workspaces: workspaces.map((entry) => ({
        id: entry.workspace.id,
        name: entry.workspace.name,
        slug: entry.workspace.slug,
        role: entry.role,
        legacyBrainEnabled: entry.workspace.legacyBrainEnabled,
      })),
      activeWorkspaceId: active?.workspace.id ?? null,
      brains: brains.map((brain) => ({
        id: brain.id,
        workspaceId: brain.workspaceId,
        name: brain.name,
        slug: brain.slug,
        description: brain.description,
        visibility: brain.visibility,
        enrichmentEnabled: brain.enrichmentEnabled,
        intelligence: brain.intelligence,
      })),
      activeBrainId: activeBrain?.id ?? null,
    };
  }

  async function localUser(identity: ApiIdentity) {
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.workosUserId, identity.userId))
      .limit(1);
    return existing ?? syncUser(await workos.userManagement.getUser(identity.userId));
  }

  return {
    async get(identity) {
      return resolve(identity, await localUser(identity));
    },
    async sync(identity) {
      const user = await syncUser(await workos.userManagement.getUser(identity.userId));
      await adoptMemberships(identity.userId);
      return resolve(identity, user);
    },
  };
}
