"use server";

import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  connectorOrganizationMemberships,
  connectorOrganizations,
  connectorPermissionGrants,
} from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  currentConnectorOrganization,
  currentConnectorUser,
  loadConnectorOrganizationForUser,
  newConnectorOrganizationId,
} from "@/lib/auth";
import { loadConnectorLinearMcpSettings } from "@/lib/mcp/data";
import {
  CONNECTOR_LINEAR_PERMISSION_SCOPES,
  type ConnectorLinearPermissions,
  parsePermissionsFormData,
} from "@/lib/permissions";
import { validateConnectorOrganizationInput } from "@/lib/slug";
import { serializeConnectorOrganization } from "./data";
import type { FinishSetupActionState, OrganizationActionState } from "./state";

export async function saveConnectorOrganizationAction(
  _prevState: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  const user = await currentConnectorUser();
  const validation = validateConnectorOrganizationInput({
    name: readFormString(formData, "name"),
    slug: readFormString(formData, "slug"),
  });

  if (!validation.ok) {
    return { error: validation.error, organization: null };
  }

  const db = getDb();
  const existingContext = await loadConnectorOrganizationForUser(user.id);
  const [slugOwner] = await db
    .select({ id: connectorOrganizations.id })
    .from(connectorOrganizations)
    .where(eq(connectorOrganizations.slug, validation.slug))
    .limit(1);

  if (slugOwner && slugOwner.id !== existingContext?.organization.id) {
    return { error: "That slug is already taken.", organization: null };
  }

  const now = new Date();
  if (existingContext) {
    const [organization] = await db
      .update(connectorOrganizations)
      .set({
        name: validation.name,
        slug: validation.slug,
        updatedAt: now,
      })
      .where(eq(connectorOrganizations.id, existingContext.organization.id))
      .returning();

    if (!organization) return { error: "Could not update the organization.", organization: null };
    revalidatePath("/setup");
    return { error: null, organization: serializeConnectorOrganization(organization) };
  }

  const [organization] = await db
    .insert(connectorOrganizations)
    .values({
      id: newConnectorOrganizationId(),
      name: validation.name,
      slug: validation.slug,
      createdByUserId: user.id,
      updatedAt: now,
    })
    .returning();

  if (!organization) return { error: "Could not create the organization.", organization: null };

  await db
    .insert(connectorOrganizationMemberships)
    .values({
      organizationId: organization.id,
      userId: user.id,
      role: "owner",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        connectorOrganizationMemberships.organizationId,
        connectorOrganizationMemberships.userId,
      ],
      set: { role: "owner", updatedAt: now },
    });

  revalidatePath("/setup");
  return { error: null, organization: serializeConnectorOrganization(organization) };
}

export async function finishConnectorSetupAction(
  _prevState: FinishSetupActionState,
  formData: FormData,
): Promise<FinishSetupActionState> {
  const { organization } = await currentConnectorOrganization();
  const permissions = parsePermissionsFormData(formData);
  await saveConnectorLinearPermissions(organization.id, permissions);

  const linear = await loadConnectorLinearMcpSettings(organization.id);
  if (!linear.configured) {
    return { error: "Connect Linear before finishing setup." };
  }

  await getDb()
    .update(connectorOrganizations)
    .set({
      setupCompletedAt: organization.setupCompletedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(connectorOrganizations.id, organization.id));

  revalidatePath("/setup");
  revalidatePath("/app");
  redirect("/app");
}

export async function saveConnectorLinearPermissions(
  organizationId: string,
  permissions: ConnectorLinearPermissions,
) {
  const db = getDb();
  const now = new Date();

  for (const scope of CONNECTOR_LINEAR_PERMISSION_SCOPES) {
    await db
      .insert(connectorPermissionGrants)
      .values({
        id: newConnectorPermissionGrantId(),
        organizationId,
        provider: "linear",
        scope,
        granted: permissions[scope],
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          connectorPermissionGrants.organizationId,
          connectorPermissionGrants.provider,
          connectorPermissionGrants.scope,
        ],
        set: {
          granted: permissions[scope],
          updatedAt: now,
        },
      });
  }
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function newConnectorPermissionGrantId() {
  return `cperm_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
