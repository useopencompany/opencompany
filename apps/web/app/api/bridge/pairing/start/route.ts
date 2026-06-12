import { randomUUID } from "node:crypto";
import { devicePairingRequests } from "@opencompany/db/schema";
import { getDb } from "@opencompany/db/client";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
// Unambiguous alphabet (no 0/O, 1/I/L) so the code survives being read aloud or retyped.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generatePairingCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

// Unauthenticated by design: the daemon on the user's machine has no session. It sends
// only a daemon-generated secret HASH plus display metadata; nothing here grants access.
// Access is granted when a logged-in user confirms the short code in their settings —
// that authenticated step binds the request to their workspace.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const secretHash = typeof record.secretHash === "string" ? record.secretHash.trim() : "";
  const deviceName =
    typeof record.deviceName === "string" ? record.deviceName.trim().slice(0, 80) : "";
  const platform =
    typeof record.platform === "string" ? record.platform.trim().slice(0, 30) : "unknown";
  if (!/^[a-f0-9]{64}$/.test(secretHash)) {
    return NextResponse.json({ error: "secretHash must be a SHA-256 hex digest." }, { status: 400 });
  }
  if (!deviceName) {
    return NextResponse.json({ error: "deviceName is required." }, { status: 400 });
  }

  const requestId = `dpair_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await getDb().insert(devicePairingRequests).values({
    id: requestId,
    code,
    secretHash,
    deviceName,
    platform,
    expiresAt,
  });

  return NextResponse.json({
    requestId,
    code,
    expiresAt: expiresAt.toISOString(),
    pollIntervalMs: POLL_INTERVAL_MS,
    confirmUrl: `${request.nextUrl.origin}/personal/settings/devices`,
  });
}
