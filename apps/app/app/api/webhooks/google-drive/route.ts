import { createHash, timingSafeEqual } from "node:crypto";
import {
  loadGoogleDriveWatchChannel,
  requestGoogleDriveCursorWake,
} from "@opencompany/db/google-drive";
import { triggerGoogleDriveSyncWake } from "@/lib/task-runner";

export async function POST(request: Request) {
  const channelId = request.headers.get("x-goog-channel-id")?.trim();
  const channelToken = request.headers.get("x-goog-channel-token")?.trim();
  const resourceId = request.headers.get("x-goog-resource-id")?.trim();
  const resourceState = request.headers.get("x-goog-resource-state")?.trim();
  if (!channelId || !channelToken || !resourceId || !resourceState) {
    return new Response("Missing Google Drive notification headers.", { status: 400 });
  }
  const channel = await loadGoogleDriveWatchChannel(channelId);
  if (
    !channel ||
    channel.status === "stopped" ||
    (channel.expiresAt && channel.expiresAt.getTime() <= Date.now()) ||
    !safeEqual(channel.tokenHash, sha256(channelToken)) ||
    (channel.resourceId && !safeEqual(channel.resourceId, resourceId))
  ) {
    return new Response("Invalid Google Drive notification channel.", { status: 401 });
  }

  // Google can deliver the initial sync before the watch response reaches the
  // runner. The creating row already holds the channel id/token, so accepting
  // it here is safe even while resource_id is not populated yet.
  if (resourceState === "sync" || resourceState === "change") {
    await requestGoogleDriveCursorWake(channel.cursorId);
    triggerGoogleDriveSyncWake().catch((error) => {
      console.warn("Google Drive webhook could not wake the sync worker.", {
        event: "goat.google_drive_webhook_wake_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return new Response(null, { status: 204 });
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
