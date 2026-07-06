import { getDb } from "@opencompany/db/client";
import { goatUsers } from "@opencompany/db/goat-schema";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { User as WorkOSUser } from "@workos-inc/node";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";

export type GoatAuthContext = {
  authUser: WorkOSUser;
  user: typeof goatUsers.$inferSelect;
};

export async function syncGoatUser(authUser: WorkOSUser) {
  const db = getDb();
  const now = new Date();

  const [user] = await db
    .insert(goatUsers)
    .values({
      workosUserId: authUser.id,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      avatarUrl: authUser.profilePictureUrl,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: goatUsers.workosUserId,
      set: {
        email: authUser.email,
        firstName: authUser.firstName,
        lastName: authUser.lastName,
        avatarUrl: authUser.profilePictureUrl,
        updatedAt: now,
      },
    })
    .returning();

  if (!user) {
    throw new Error("Unable to sync the Goat user.");
  }

  return user;
}

const resolveGoatAuthContext = cache(async (): Promise<GoatAuthContext | null> => {
  const session = await withAuth();
  if (!session.user) return null;

  const db = getDb();
  const [existingUser] = await db
    .select()
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, session.user.id))
    .limit(1);

  return {
    authUser: session.user,
    user: existingUser ?? (await syncGoatUser(session.user)),
  };
});

export async function currentGoatUser(options: { optional: true }): Promise<GoatAuthContext | null>;
export async function currentGoatUser(options?: { optional?: false }): Promise<GoatAuthContext>;
export async function currentGoatUser(options: { optional?: boolean } = {}) {
  const context = await resolveGoatAuthContext();
  if (!context) {
    if (options.optional) return null;
    redirect("/auth/sign-in");
  }
  return context;
}
