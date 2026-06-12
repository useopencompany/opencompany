"use server";

import { randomUUID } from "node:crypto";
import {
  deviceActions,
  devicePairingRequests,
  workspaceDevices,
} from "@opencompany/db/schema";
import { getDb } from "@opencompany/db/client";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { callRunner } from "@/lib/agent-sessions/runner";
import { currentWorkspace } from "@/lib/auth";

// A device whose daemon reported in within this window is shown as online. The web app
// has no live socket to the daemon (only the runner does), so lastSeenAt is the signal.
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

export type DeviceSummary = {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
};

export type DeviceActionSummary = {
  id: string;
  deviceName: string;
  tool: string;
  summary: string;
  decision: string;
  createdAt: string;
};

// Confirm a pairing code shown by `oc-bridge pair` on the user's machine. This is the
// authenticated half of the device-code flow: it binds the daemon's pairing request to
// THIS user + workspace and mints the device row (carrying over the daemon's secret
// hash — the secret itself never left the device).
export async function confirmDevicePairing(input: { code: string }) {
  const { user, workspace } = await currentWorkspace();
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) {
    return { ok: false, error: "Enter the 6-character code shown in your terminal." } as const;
  }
  const formatted = `${code.slice(0, 3)}-${code.slice(3)}`;

  const db = getDb();
  const [request] = await db
    .select()
    .from(devicePairingRequests)
    .where(
      and(
        eq(devicePairingRequests.code, formatted),
        eq(devicePairingRequests.status, "pending"),
        gt(devicePairingRequests.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(devicePairingRequests.createdAt))
    .limit(1);
  if (!request) {
    return { ok: false, error: "Code not found or expired. Run `oc-bridge pair` again." } as const;
  }

  const deviceId = `dvc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(workspaceDevices).values({
    id: deviceId,
    workspaceId: workspace.id,
    userId: user.id,
    name: request.deviceName,
    platform: request.platform,
    secretHash: request.secretHash,
  });
  const confirmed = await db
    .update(devicePairingRequests)
    .set({ status: "confirmed", deviceId, updatedAt: new Date() })
    .where(
      and(eq(devicePairingRequests.id, request.id), eq(devicePairingRequests.status, "pending")),
    )
    .returning({ id: devicePairingRequests.id });
  if (confirmed.length === 0) {
    // A concurrent confirm won the row; roll back our orphaned device.
    await db.delete(workspaceDevices).where(eq(workspaceDevices.id, deviceId));
    return { ok: false, error: "This code was already confirmed." } as const;
  }

  revalidatePath("/personal/settings/devices");
  return { ok: true, deviceName: request.deviceName } as const;
}

// Revoke a device: flips it server-side (its secret stops authenticating) and asks the
// runner to drop the live socket so access ends now, not at the next reconnect.
export async function revokeDevice(input: { deviceId: string }) {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const updated = await db
    .update(workspaceDevices)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(
      and(
        eq(workspaceDevices.id, input.deviceId),
        eq(workspaceDevices.workspaceId, workspace.id),
        eq(workspaceDevices.userId, user.id),
        eq(workspaceDevices.status, "active"),
      ),
    )
    .returning({ id: workspaceDevices.id });
  if (updated.length === 0) {
    return { ok: false, error: "Device not found." } as const;
  }
  try {
    await callRunner(`/internal/devices/${input.deviceId}/disconnect`, {
      event: "opencompany.device_disconnect_failed",
    });
  } catch {
    // Best effort: the DB flip already blocks the next connect and every re-auth.
  }
  revalidatePath("/personal/settings/devices");
  return { ok: true } as const;
}

export async function loadMyDevices(): Promise<DeviceSummary[]> {
  const { user, workspace } = await currentWorkspace();
  const rows = await getDb()
    .select()
    .from(workspaceDevices)
    .where(
      and(
        eq(workspaceDevices.workspaceId, workspace.id),
        eq(workspaceDevices.userId, user.id),
        eq(workspaceDevices.status, "active"),
      ),
    )
    .orderBy(desc(workspaceDevices.createdAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    online: row.lastSeenAt ? Date.now() - row.lastSeenAt.getTime() < ONLINE_WINDOW_MS : false,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function loadMyDeviceActions(): Promise<DeviceActionSummary[]> {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const devices = await db
    .select({ id: workspaceDevices.id, name: workspaceDevices.name })
    .from(workspaceDevices)
    .where(
      and(eq(workspaceDevices.workspaceId, workspace.id), eq(workspaceDevices.userId, user.id)),
    );
  if (devices.length === 0) return [];
  const nameById = new Map(devices.map((device) => [device.id, device.name]));
  const rows = await db
    .select()
    .from(deviceActions)
    .where(
      inArray(
        deviceActions.deviceId,
        devices.map((device) => device.id),
      ),
    )
    .orderBy(desc(deviceActions.createdAt))
    .limit(50);
  return rows.map((row) => ({
    id: row.id,
    deviceName: nameById.get(row.deviceId) ?? row.deviceId,
    tool: row.tool,
    summary: row.summary,
    decision: row.decision,
    createdAt: row.createdAt.toISOString(),
  }));
}
