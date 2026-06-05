"use server";

import { getDb } from "@opencompany/db/client";
import { workspaceIntegrationResources, workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import type { GoogleIntegrationProvider } from "@/lib/integrations/google-oauth";
import {
  disconnectGoogleIntegration,
  GOOGLE_CALENDAR_RESOURCE_TYPE,
} from "@/lib/integrations/google-service";

export type DisconnectGoogleIntegrationResult = {
  ok: boolean;
  status: "disconnected" | "not_connected" | "forbidden";
  message: string;
};

export async function disconnectGoogleIntegrationAction(input: {
  provider: GoogleIntegrationProvider;
  integrationId: string;
}): Promise<DisconnectGoogleIntegrationResult> {
  const { workspace, user, role } = await currentWorkspace();
  const db = getDb();

  const [existing] = await db
    .select({ connectedByUserId: workspaceIntegrations.connectedByUserId })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspace.id),
        eq(workspaceIntegrations.provider, input.provider),
        eq(workspaceIntegrations.id, input.integrationId),
      ),
    )
    .limit(1);

  if (!existing) {
    return { ok: true, status: "not_connected", message: "This account was already disconnected." };
  }

  // Per-user integrations: only the connecting member or an admin can remove a connection.
  if (existing.connectedByUserId !== user.id && role !== "admin") {
    return {
      ok: false,
      status: "forbidden",
      message: "Only the member who connected this account or a workspace admin can disconnect it.",
    };
  }

  await disconnectGoogleIntegration({
    workspaceId: workspace.id,
    provider: input.provider,
    integrationId: input.integrationId,
  });
  revalidateIntegrationPaths();

  return { ok: true, status: "disconnected", message: "Disconnected the Google account." };
}

export type SetGoogleCalendarSelectionResult = {
  ok: boolean;
  status: "updated" | "not_found" | "forbidden";
};

export async function setGoogleCalendarSelection(input: {
  integrationId: string;
  calendarExternalId: string;
  selected: boolean;
}): Promise<SetGoogleCalendarSelectionResult> {
  const { workspace, user, role } = await currentWorkspace();
  const db = getDb();

  const [existing] = await db
    .select({ connectedByUserId: workspaceIntegrations.connectedByUserId })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspace.id),
        eq(workspaceIntegrations.provider, "google_calendar"),
        eq(workspaceIntegrations.id, input.integrationId),
      ),
    )
    .limit(1);

  if (!existing) {
    return { ok: false, status: "not_found" };
  }
  // Per-user integrations: only the connecting member or an admin can change calendar selection.
  if (existing.connectedByUserId !== user.id && role !== "admin") {
    return { ok: false, status: "forbidden" };
  }

  const updated = await db
    .update(workspaceIntegrationResources)
    .set({ selectedAt: input.selected ? new Date() : null, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceIntegrationResources.workspaceId, workspace.id),
        eq(workspaceIntegrationResources.integrationId, input.integrationId),
        eq(workspaceIntegrationResources.provider, "google_calendar"),
        eq(workspaceIntegrationResources.resourceType, GOOGLE_CALENDAR_RESOURCE_TYPE),
        eq(workspaceIntegrationResources.externalId, input.calendarExternalId),
      ),
    )
    .returning({ id: workspaceIntegrationResources.id });

  if (updated.length === 0) {
    return { ok: false, status: "not_found" };
  }

  revalidateIntegrationPaths();
  return { ok: true, status: "updated" };
}

function revalidateIntegrationPaths() {
  revalidatePath("/agents");
  revalidatePath("/settings");
  revalidatePath("/settings/integrations");
}
