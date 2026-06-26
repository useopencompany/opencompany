import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  connectorOrganizationMemberships,
  connectorOrganizations,
  connectorUsers,
} from "@opencompany/db/schema";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { User as WorkOSUser } from "@workos-inc/node";
import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

export type ConnectorUser = typeof connectorUsers.$inferSelect;
export type ConnectorOrganization = typeof connectorOrganizations.$inferSelect;
export type ConnectorOrganizationMembership = typeof connectorOrganizationMemberships.$inferSelect;

export type ConnectorOrganizationContext = {
  user: ConnectorUser;
  organization: ConnectorOrganization;
  membership: ConnectorOrganizationMembership;
};

export function connectorUserId(workosUserId: string) {
  return `cusr_${workosUserId}`;
}

export function newConnectorOrganizationId() {
  return `corg_${randomUUID()}`;
}

export async function syncConnectorUser(authUser: WorkOSUser) {
  const db = getDb();
  const now = new Date();
  const [user] = await db
    .insert(connectorUsers)
    .values({
      id: connectorUserId(authUser.id),
      workosUserId: authUser.id,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      avatarUrl: authUser.profilePictureUrl,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: connectorUsers.workosUserId,
      set: {
        email: authUser.email,
        firstName: authUser.firstName,
        lastName: authUser.lastName,
        avatarUrl: authUser.profilePictureUrl,
        updatedAt: now,
      },
    })
    .returning();

  if (!user) throw new Error("Unable to sync the current Connector user.");
  return user;
}

export async function currentConnectorUser() {
  const { user: authUser } = await withAuth();
  if (!authUser) redirect("/auth/sign-in");
  return syncConnectorUser(authUser);
}

export async function redirectToConnectorHomeForAuthUser(authUser: WorkOSUser) {
  const user = await syncConnectorUser(authUser);
  const context = await loadConnectorOrganizationForUser(user.id);

  if (context?.organization.setupCompletedAt) {
    redirect("/app");
  }

  redirect("/setup");
}

export async function loadConnectorOrganizationForUser(
  userId: string,
): Promise<Omit<ConnectorOrganizationContext, "user"> | null> {
  const [row] = await getDb()
    .select({
      organization: connectorOrganizations,
      membership: connectorOrganizationMemberships,
    })
    .from(connectorOrganizationMemberships)
    .innerJoin(
      connectorOrganizations,
      eq(connectorOrganizations.id, connectorOrganizationMemberships.organizationId),
    )
    .where(eq(connectorOrganizationMemberships.userId, userId))
    .orderBy(asc(connectorOrganizationMemberships.createdAt))
    .limit(1);

  return row ?? null;
}

export async function currentConnectorOrganization(options?: { requireCompleted?: boolean }) {
  const user = await currentConnectorUser();
  const organization = await loadConnectorOrganizationForUser(user.id);

  if (!organization) redirect("/setup");
  if (options?.requireCompleted && !organization.organization.setupCompletedAt) {
    redirect("/setup");
  }

  return { user, ...organization };
}

export function displayConnectorUserName(user: ConnectorUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email;
}
