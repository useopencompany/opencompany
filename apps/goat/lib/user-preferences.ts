"use server";

import { normalizeScheduleTimezone } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { goatUsers } from "@opencompany/db/goat-schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";

export async function updateGoatTimezoneAction(timezone: string) {
  const { user } = await currentGoatUser();
  const normalized = normalizeScheduleTimezone(timezone);
  if (normalized === user.timezone) return { ok: true, timezone: normalized } as const;

  const [updated] = await getDb()
    .update(goatUsers)
    .set({ timezone: normalized, updatedAt: new Date() })
    .where(eq(goatUsers.workosUserId, user.workosUserId))
    .returning({ timezone: goatUsers.timezone });

  return { ok: Boolean(updated), timezone: updated?.timezone ?? user.timezone } as const;
}

export async function updateGoatTaskSpawningAction(enabled: boolean) {
  const { user } = await currentGoatUser();
  const nextEnabled = enabled === true;
  if (nextEnabled === user.taskSpawningEnabled) {
    return { ok: true, enabled: nextEnabled } as const;
  }

  const [updated] = await getDb()
    .update(goatUsers)
    .set({ taskSpawningEnabled: nextEnabled, updatedAt: new Date() })
    .where(eq(goatUsers.workosUserId, user.workosUserId))
    .returning({ taskSpawningEnabled: goatUsers.taskSpawningEnabled });

  revalidatePath("/");
  revalidatePath("/settings/preferences");
  return {
    ok: Boolean(updated),
    enabled: updated?.taskSpawningEnabled ?? user.taskSpawningEnabled,
  } as const;
}

export async function updateGoatAutoModelRoutingAction(enabled: boolean) {
  const { user } = await currentGoatUser();
  const nextEnabled = enabled === true;
  if (nextEnabled === user.autoModelRoutingEnabled) {
    return { ok: true, enabled: nextEnabled } as const;
  }

  const [updated] = await getDb()
    .update(goatUsers)
    .set({ autoModelRoutingEnabled: nextEnabled, updatedAt: new Date() })
    .where(eq(goatUsers.workosUserId, user.workosUserId))
    .returning({ autoModelRoutingEnabled: goatUsers.autoModelRoutingEnabled });

  revalidatePath("/");
  revalidatePath("/settings/preferences");
  return {
    ok: Boolean(updated),
    enabled: updated?.autoModelRoutingEnabled ?? user.autoModelRoutingEnabled,
  } as const;
}
