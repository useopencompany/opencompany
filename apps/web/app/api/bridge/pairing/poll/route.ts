import { getDb } from "@opencompany/db/client";
import { devicePairingRequests, workspaceDevices } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// The daemon's pairing poll. It proves possession of the device secret by sending the
// same hash it registered with — without it, knowing a requestId reveals nothing.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const requestId = typeof record.requestId === "string" ? record.requestId.trim() : "";
  const secretHash = typeof record.secretHash === "string" ? record.secretHash.trim() : "";
  if (!requestId || !secretHash) {
    return NextResponse.json({ error: "requestId and secretHash are required." }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(devicePairingRequests)
    .where(
      and(
        eq(devicePairingRequests.id, requestId),
        eq(devicePairingRequests.secretHash, secretHash),
      ),
    )
    .limit(1);
  if (!row) {
    return NextResponse.json({ status: "expired" });
  }

  if (row.status === "pending" && row.expiresAt.getTime() < Date.now()) {
    await db
      .update(devicePairingRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(devicePairingRequests.id, row.id));
    return NextResponse.json({ status: "expired" });
  }
  if (row.status !== "confirmed" || !row.deviceId) {
    return NextResponse.json({ status: row.status === "pending" ? "pending" : "expired" });
  }

  const [device] = await db
    .select({ id: workspaceDevices.id, workspaceId: workspaceDevices.workspaceId })
    .from(workspaceDevices)
    .where(eq(workspaceDevices.id, row.deviceId))
    .limit(1);
  if (!device) {
    return NextResponse.json({ status: "expired" });
  }

  const runnerUrl = (
    process.env.RUNNER_PUBLIC_URL ??
    process.env.RUNNER_INTERNAL_URL ??
    ""
  ).replace(/\/+$/, "");
  return NextResponse.json({
    status: "confirmed",
    deviceId: device.id,
    workspaceId: device.workspaceId,
    runnerUrl,
  });
}
