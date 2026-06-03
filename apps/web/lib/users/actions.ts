"use server";

import { getDb } from "@opencompany/db/client";
import { userAvatars } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { AUTHENTICATION_REQUIRED_MESSAGE, currentWorkspace } from "@/lib/auth";

// Avatars are resized to ~256px webp on the client; this is a generous hard cap so a
// crafted request can't push large blobs into Postgres.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_AVATAR_MIME = new Set(["image/webp", "image/jpeg", "image/png"]);

export async function updateAvatar(input: { dataBase64: string; mime: string }) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  if (!ALLOWED_AVATAR_MIME.has(input.mime)) {
    return { ok: false as const, error: "Unsupported image type. Use PNG, JPEG, or WebP." };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(input.dataBase64, "base64");
  } catch {
    return { ok: false as const, error: "Could not read the image." };
  }
  if (buffer.length === 0) {
    return { ok: false as const, error: "The image is empty." };
  }
  if (buffer.length > MAX_AVATAR_BYTES) {
    return { ok: false as const, error: "Image is too large (max 2 MB)." };
  }

  const db = getDb();
  const now = new Date();
  await db
    .insert(userAvatars)
    .values({ userId: context.user.id, blob: buffer, mime: input.mime, updatedAt: now })
    .onConflictDoUpdate({
      target: userAvatars.userId,
      set: { blob: buffer, mime: input.mime, updatedAt: now },
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
