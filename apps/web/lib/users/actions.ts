"use server";

import { getDb } from "@opencompany/db/client";
import { userAvatars } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { AUTHENTICATION_REQUIRED_MESSAGE, currentWorkspace } from "@/lib/auth";

// Avatars are resized to ~256px webp on the client; this is a generous hard cap so a
// crafted request can't push large blobs into Postgres.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

// Sniff the real image type from magic bytes instead of trusting the client-declared
// mime — a request can bypass the client resizer, so the stored mime (which the serve
// route echoes back as Content-Type) must be derived from the actual content.
function detectImageMime(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function updateAvatar(input: { dataBase64: string }) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const buffer = Buffer.from(input.dataBase64, "base64");
  if (buffer.length === 0) {
    return { ok: false as const, error: "The image is empty." };
  }
  if (buffer.length > MAX_AVATAR_BYTES) {
    return { ok: false as const, error: "Image is too large (max 2 MB)." };
  }

  const mime = detectImageMime(buffer);
  if (!mime) {
    return { ok: false as const, error: "Unsupported image. Use PNG, JPEG, or WebP." };
  }

  const db = getDb();
  const now = new Date();
  await db
    .insert(userAvatars)
    .values({ userId: context.user.id, blob: buffer, mime, updatedAt: now })
    .onConflictDoUpdate({
      target: userAvatars.userId,
      set: { blob: buffer, mime, updatedAt: now },
    });

  revalidatePath("/", "layout");
  revalidatePath("/settings");
  return { ok: true as const };
}

export async function removeAvatar() {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const db = getDb();
  await db.delete(userAvatars).where(eq(userAvatars.userId, context.user.id));

  revalidatePath("/", "layout");
  revalidatePath("/settings");
  return { ok: true as const };
}
